/**
 * Database connection and query helpers
 *
 * RLS integration: When a user context is active (via rlsContext middleware),
 * all queries automatically set `app.current_user_id` so PostgreSQL RLS
 * policies filter rows. No changes needed in service code.
 */

const { Pool } = require('pg');
const { AsyncLocalStorage } = require('node:async_hooks');
const config = require('./index');

let pool = null;

/**
 * AsyncLocalStorage that holds the current user's UUID for RLS.
 * Populated by the rlsContext middleware for every authenticated request.
 */
const rlsStorage = new AsyncLocalStorage();

/**
 * Initialize database connection pool
 */
function initializePool() {
  if (pool) return pool;
  
  if (!config.database.url) {
    console.warn('DATABASE_URL not set, using mock database');
    return null;
  }

  // Strip sslmode from connection string — we handle SSL via the ssl option
  // to avoid pg treating sslmode=require as verify-full
  const connectionString = config.database.url.replace(/[?&]sslmode=[^&]*/g, (match) =>
    match.startsWith('?') ? '?' : ''
  ).replace(/\?$/, '').replace(/\?&/, '?');
  
  pool = new Pool({
    connectionString,
    ssl: config.database.ssl,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
  
  pool.on('error', (err) => {
    console.error('Unexpected database error:', err);
  });
  
  return pool;
}

/**
 * Execute a query
 * 
 * When an RLS user context is active (set by rlsContext middleware),
 * acquires a dedicated client, sets app.current_user_id, runs the query,
 * then releases. Otherwise falls back to the pool directly.
 *
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Object>} Query result
 */
async function query(text, params) {
  const db = initializePool();
  
  if (!db) {
    throw new Error('Database not configured');
  }

  const userId = rlsStorage.getStore();
  
  const start = Date.now();
  let result;

  if (userId) {
    // RLS path: wrap set_config + query in an explicit transaction so
    // is_local=true stays active for the actual query (in autocommit mode
    // each statement is its own transaction, so is_local=true evaporates
    // before the next statement without an explicit BEGIN/COMMIT).
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
      result = await client.query(text, params);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } else {
    result = await db.query(text, params);
  }

  const duration = Date.now() - start;
  
  if (config.nodeEnv === 'development') {
    console.log('Query executed', { text: text.substring(0, 50), duration, rows: result.rowCount });
  }
  
  return result;
}

/**
 * Execute a query and return first row
 * 
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Object|null>} First row or null
 */
async function queryOne(text, params) {
  const result = await query(text, params);
  return result.rows[0] || null;
}

/**
 * Execute a query and return all rows
 * 
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Array>} All rows
 */
async function queryAll(text, params) {
  const result = await query(text, params);
  return result.rows;
}

/**
 * Execute multiple queries in a transaction
 * Automatically sets RLS context if a user is active.
 * 
 * @param {Function} callback - Function receiving client
 * @returns {Promise<any>} Transaction result
 */
async function transaction(callback) {
  const db = initializePool();
  
  if (!db) {
    throw new Error('Database not configured');
  }
  
  const client = await db.connect();
  
  try {
    await client.query('BEGIN');

    const userId = rlsStorage.getStore();
    if (userId) {
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    }

    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Check database connection
 * 
 * @returns {Promise<boolean>}
 */
async function healthCheck() {
  try {
    const db = initializePool();
    if (!db) return false;
    
    await db.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Close database connections
 */
async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Execute a query scoped to a specific user (sets RLS context).
 * This ensures Row-Level Security policies filter results to the given user.
 *
 * @param {string} userId - The UUID of the current user
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Object>} Query result
 */
async function tenantQuery(userId, text, params) {
  const db = initializePool();
  if (!db) throw new Error('Database not configured');

  const client = await db.connect();
  try {
    // Set the RLS user context for this connection
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    const start = Date.now();
    const result = await client.query(text, params);
    const duration = Date.now() - start;
    if (config.nodeEnv === 'development') {
      console.log('Tenant query executed', { userId, text: text.substring(0, 50), duration, rows: result.rowCount });
    }
    return result;
  } finally {
    client.release();
  }
}

/**
 * Execute multiple queries in a transaction scoped to a specific user.
 *
 * @param {string} userId - The UUID of the current user
 * @param {Function} callback - Function receiving client
 * @returns {Promise<any>} Transaction result
 */
async function tenantTransaction(userId, callback) {
  const db = initializePool();
  if (!db) throw new Error('Database not configured');

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Create the waitlist table if it does not already exist.
 * Called once at startup — safe to run repeatedly (idempotent).
 */
async function migrateWaitlist() {
  const db = initializePool();
  if (!db) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS waitlist (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username      VARCHAR(32)  NOT NULL,
      email         VARCHAR(254) NOT NULL UNIQUE,
      password_hash TEXT         NOT NULL,
      display_name  VARCHAR(50),
      status        VARCHAR(16)  NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected')),
      notes         TEXT,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      reviewed_at   TIMESTAMPTZ
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS waitlist_status_idx ON waitlist (status)`);
}

module.exports = {
  initializePool,
  query,
  queryOne,
  queryAll,
  transaction,
  tenantQuery,
  tenantTransaction,
  rlsStorage,
  healthCheck,
  close,
  migrateWaitlist,
  getPool: () => pool
};
