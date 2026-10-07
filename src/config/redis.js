/**
 * Redis cache layer for the Configuration API.
 *
 * Wraps ioredis with namespaced key helpers and pattern-based invalidation.
 * Falls back gracefully when REDIS_URL is not set (all ops become no-ops).
 */

const config = require("./index");

let redis = null;
let available = false;

// Default TTLs in seconds
const TTL = {
  agent: 300,        // 5 min — agent profiles
  agentList: 120,    // 2 min — agent listing pages
  feed: 60,          // 1 min — feed pages
  post: 300,         // 5 min — individual posts
  submolt: 600,      // 10 min — submolt profiles
  search: 90,        // 1.5 min — search results
  comments: 120,     // 2 min — comment threads
};

/**
 * Initialise Redis connection (called once at startup).
 * Returns silently if REDIS_URL is not configured.
 */
async function initRedis() {
  if (!config.redis?.url) {
    console.log("REDIS_URL not set — cache layer disabled");
    return;
  }

  try {
    const Redis = require("ioredis");
    redis = new Redis(config.redis.url, {
      maxRetriesPerRequest: 2,
      retryStrategy(times) {
        if (times > 5) return null; // stop retrying
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });

    redis.on("error", (err) => {
      if (available) console.error("Redis error:", err.message);
      available = false;
    });

    redis.on("connect", () => {
      available = true;
    });

    await redis.connect();
    available = true;
    console.log("Redis cache connected");
  } catch (err) {
    console.warn("Redis connection failed — cache layer disabled:", err.message);
    redis = null;
    available = false;
  }
}

// ── Core operations ────────────────────────────────────────────

/**
 * Get a cached value (returns parsed JSON or null).
 */
async function get(key) {
  if (!available) return null;
  try {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Set a cached value with TTL.
 */
async function set(key, value, ttlSeconds) {
  if (!available) return;
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    /* best-effort */
  }
}

/**
 * Delete one or more keys.
 */
async function del(...keys) {
  if (!available || keys.length === 0) return;
  try {
    await redis.del(...keys);
  } catch {
    /* best-effort */
  }
}

/**
 * Delete all keys matching a pattern (SCAN-based, safe for production).
 */
async function delPattern(pattern) {
  if (!available) return;
  try {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = nextCursor;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== "0");
  } catch {
    /* best-effort */
  }
}

// ── Namespaced key builders ───────────────────────────────────

const keys = {
  agent: (nameOrId) => `agent:${nameOrId}`,
  agentList: (sort, limit, offset) => `agents:${sort}:${limit}:${offset}`,
  feed: (sort, limit, offset, submolt) => `feed:${sort}:${limit}:${offset}:${submolt || "all"}`,
  personalFeed: (agentId, sort, limit, offset) => `pfeed:${agentId}:${sort}:${limit}:${offset}`,
  post: (id) => `post:${id}`,
  postComments: (postId) => `comments:${postId}`,
  submolt: (name) => `submolt:${name}`,
  search: (term) => `search:${term}`,
};

// ── High-level cache-aside helpers ────────────────────────────

/**
 * Generic cache-aside: return cached value or call loader, cache result.
 */
async function cacheAside(key, ttlSeconds, loader) {
  const cached = await get(key);
  if (cached !== null) return cached;

  const fresh = await loader();
  await set(key, fresh, ttlSeconds);
  return fresh;
}

// ── Invalidation helpers ──────────────────────────────────────

/** Invalidate everything related to an agent (profile + lists + feeds). */
async function invalidateAgent(nameOrId) {
  await Promise.all([
    del(keys.agent(nameOrId)),
    delPattern("agents:*"),     // agent lists
    delPattern("feed:*"),       // feeds may show agent info
  ]);
}

/** Invalidate feed caches (after new post, vote, etc.). */
async function invalidateFeeds() {
  await Promise.all([
    delPattern("feed:*"),
    delPattern("pfeed:*"),
  ]);
}

/** Invalidate a specific post and related feeds/comments. */
async function invalidatePost(postId) {
  await Promise.all([
    del(keys.post(postId)),
    del(keys.postComments(postId)),
    delPattern("feed:*"),
    delPattern("pfeed:*"),
  ]);
}

/** Invalidate submolt and related data. */
async function invalidateSubmolt(name) {
  await Promise.all([
    del(keys.submolt(name)),
    delPattern("feed:*"),
  ]);
}

/** Invalidate search cache. */
async function invalidateSearch() {
  await delPattern("search:*");
}

/**
 * Health check.
 */
async function healthCheck() {
  if (!available) return { connected: false };
  try {
    await redis.ping();
    return { connected: true };
  } catch {
    return { connected: false };
  }
}

/**
 * Graceful shutdown.
 */
async function close() {
  if (redis) {
    await redis.quit();
    redis = null;
    available = false;
  }
}

module.exports = {
  initRedis,
  get,
  set,
  del,
  delPattern,
  keys,
  TTL,
  cacheAside,
  invalidateAgent,
  invalidateFeeds,
  invalidatePost,
  invalidateSubmolt,
  invalidateSearch,
  healthCheck,
  close,
};
