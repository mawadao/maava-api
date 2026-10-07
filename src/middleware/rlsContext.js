/**
 * RLS Context Middleware
 *
 * Resolves the current user's UUID from the authenticated request and
 * stores it in AsyncLocalStorage so all downstream database queries
 * automatically set `app.current_user_id` for PostgreSQL RLS policies.
 *
 * Must run AFTER authentication middleware (requireAuth / requireUserAuth).
 *
 * Two resolution paths:
 *  1. req.user.id  — Already a user UUID (user-auth routes: channels, users)
 *  2. req.agent.id — Agent UUID; look up the owning user's UUID via agents.user_id
 */

const { rlsStorage } = require('../config/database');
const { queryOne } = require('../config/database');

// Simple in-memory cache: agentId → userId (avoids a DB lookup per request).
// Entries never expire during the process lifetime, which is safe because
// agent→user ownership doesn't change.
const agentUserCache = new Map();

/**
 * Express middleware that wraps the rest of the handler chain inside an
 * AsyncLocalStorage context carrying the current user UUID.
 */
function rlsContext(req, res, next) {
  // Determine userId synchronously if possible
  if (req.user && req.user.id) {
    rlsStorage.run(req.user.id, () => next());
    return;
  }

  if (req.agent && req.agent.id) {
    const cached = agentUserCache.get(req.agent.id);
    if (cached) {
      rlsStorage.run(cached, () => next());
      return;
    }

    // Look up the owning user — this query runs WITHOUT RLS (no store set yet)
    queryOne('SELECT user_id FROM agents WHERE id = $1', [req.agent.id])
      .then((row) => {
        const userId = row?.user_id;
        if (userId) {
          agentUserCache.set(req.agent.id, userId);
          rlsStorage.run(userId, () => next());
        } else {
          // Agent has no linked user — proceed without RLS context.
          // Public-read RLS policies will still allow SELECT.
          next();
        }
      })
      .catch((err) => next(err));
    return;
  }

  // No authenticated identity — proceed without RLS context
  next();
}

module.exports = { rlsContext };
