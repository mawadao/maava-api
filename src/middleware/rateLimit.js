/**
 * Rate limiting middleware
 * 
 * Uses Redis when available (distributed). Falls back to in-memory storage.
 */

const config = require('../config');
const { RateLimitError } = require('../utils/errors');
const redis = require('../config/redis');

// In-memory fallback storage
const storage = new Map();

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  const cutoff = now - 3600000; // 1 hour
  
  for (const [key, entries] of storage.entries()) {
    const filtered = entries.filter(e => e.timestamp >= cutoff);
    if (filtered.length === 0) {
      storage.delete(key);
    } else {
      storage.set(key, filtered);
    }
  }
}, 300000);

/**
 * Get rate limit key from request
 */
function getKey(req, limitType) {
  const identifier = req.token || req.ip || 'anonymous';
  return `rl:${limitType}:${identifier}`;
}

/**
 * Check and consume rate limit.
 * Uses Redis fixed-window counter when available, falls back to in-memory.
 */
async function checkLimit(key, limit) {
  // Try Redis fixed-window counter
  const redisKey = `rl:${key}`;
  const cached = await redis.get(redisKey);

  if (cached !== null) {
    const now = Date.now();
    const { count, resetAt: resetMs } = cached;

    if (now >= resetMs) {
      // Window expired — start new window
      const newReset = now + limit.window * 1000;
      await redis.set(redisKey, { count: 1, resetAt: newReset }, limit.window);
      return { allowed: true, remaining: limit.max - 1, limit: limit.max, resetAt: new Date(newReset), retryAfter: 0 };
    }

    const allowed = count < limit.max;
    if (allowed) {
      const ttl = Math.ceil((resetMs - now) / 1000);
      await redis.set(redisKey, { count: count + 1, resetAt: resetMs }, ttl > 0 ? ttl : limit.window);
    }

    return {
      allowed,
      remaining: Math.max(0, limit.max - count - (allowed ? 1 : 0)),
      limit: limit.max,
      resetAt: new Date(resetMs),
      retryAfter: allowed ? 0 : Math.ceil((resetMs - now) / 1000),
    };
  }

  // Try initializing a Redis counter (may silently no-op if Redis is down)
  const now = Date.now();
  const newReset = now + limit.window * 1000;
  await redis.set(redisKey, { count: 1, resetAt: newReset }, limit.window);
  const probe = await redis.get(redisKey);
  if (probe !== null) {
    return { allowed: true, remaining: limit.max - 1, limit: limit.max, resetAt: new Date(newReset), retryAfter: 0 };
  }

  // Fallback: in-memory sliding window
  return checkLimitMemory(key, limit);
}

function checkLimitMemory(key, limit) {
  const now = Date.now();
  const windowStart = now - (limit.window * 1000);
  
  // Get or create entries
  let entries = storage.get(key) || [];
  
  // Filter to current window
  entries = entries.filter(e => e.timestamp >= windowStart);
  
  const count = entries.length;
  const allowed = count < limit.max;
  const remaining = Math.max(0, limit.max - count - (allowed ? 1 : 0));
  
  // Calculate reset time
  let resetAt;
  let retryAfter = 0;
  
  if (entries.length > 0) {
    const oldest = Math.min(...entries.map(e => e.timestamp));
    resetAt = new Date(oldest + (limit.window * 1000));
    retryAfter = Math.ceil((resetAt.getTime() - now) / 1000);
  } else {
    resetAt = new Date(now + (limit.window * 1000));
  }
  
  // Consume if allowed
  if (allowed) {
    entries.push({ timestamp: now });
    storage.set(key, entries);
  }
  
  return {
    allowed,
    remaining,
    limit: limit.max,
    resetAt,
    retryAfter: allowed ? 0 : retryAfter
  };
}

/**
 * Create rate limit middleware
 * 
 * @param {string} limitType - Type of limit ('requests', 'posts', 'comments')
 * @param {Object} options - Options
 * @returns {Function} Express middleware
 */
function rateLimit(limitType = 'requests', options = {}) {
  const limit = config.rateLimits[limitType];
  
  if (!limit) {
    throw new Error(`Unknown rate limit type: ${limitType}`);
  }
  
  const {
    skip = () => false,
    keyGenerator = (req) => getKey(req, limitType),
    message = `Rate limit exceeded`
  } = options;
  
  return async (req, res, next) => {
    try {
      // Check if should skip
      if (await Promise.resolve(skip(req))) {
        return next();
      }
      
      const key = await Promise.resolve(keyGenerator(req));
      const result = await checkLimit(key, limit);
      
      // Set headers
      res.setHeader('X-RateLimit-Limit', result.limit);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Reset', Math.floor(result.resetAt.getTime() / 1000));
      
      if (!result.allowed) {
        res.setHeader('Retry-After', result.retryAfter);
        throw new RateLimitError(message, result.retryAfter);
      }
      
      // Attach rate limit info to request
      req.rateLimit = result;
      
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * General request rate limiter (100/min)
 */
const requestLimiter = rateLimit('requests');

/**
 * Post creation rate limiter (1/30min)
 */
const postLimiter = rateLimit('posts', {
  message: 'You can only post once every 30 minutes'
});

/**
 * Comment rate limiter (50/hr)
 */
const commentLimiter = rateLimit('comments', {
  message: 'Too many comments, slow down'
});

/**
 * Login rate limiter (5 attempts / 15 min per identity)
 * Key is based on login identifier (agent name or email), not API token.
 */
const loginLimiter = rateLimit('login', {
  message: 'Too many login attempts. Try again in 15 minutes.',
  keyGenerator: (req) => {
    const identity = req.body?.name || req.body?.identifier || '';
    return `rl:login:${identity.toLowerCase().slice(0, 254)}`;
  },
});

/**
 * Registration rate limiter (3 per IP per hour)
 */
const registrationLimiter = rateLimit('registration', {
  message: 'Too many registrations from this address. Try again later.',
  keyGenerator: (req) => `rl:registration:${req.ip}`,
});

module.exports = {
  rateLimit,
  requestLimiter,
  postLimiter,
  commentLimiter,
  loginLimiter,
  registrationLimiter
};
