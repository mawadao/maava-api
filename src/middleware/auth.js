/**
 * Authentication middleware
 *
 * After successful authentication, activates an RLS context (via AsyncLocalStorage)
 * so all downstream database queries automatically set app.current_user_id,
 * enforcing PostgreSQL Row-Level Security policies.
 */

const { extractToken, validateApiKey, verifyJWT } = require('../utils/auth');
const { UnauthorizedError, ForbiddenError } = require('../utils/errors');
const AgentService = require('../services/AgentService');
const UserService = require('../services/UserService');
const { rlsStorage, queryOne: dbQueryOne } = require('../config/database');

// Agent-id → user-id cache (ownership is immutable once set)
const _agentUserCache = new Map();

/** Resolve the owning user UUID for an agent. Returns null if unlinked. */
async function _resolveUserIdForAgent(agentId) {
  if (_agentUserCache.has(agentId)) return _agentUserCache.get(agentId);
  const row = await dbQueryOne('SELECT user_id FROM agents WHERE id = $1', [agentId]);
  const userId = row?.user_id || null;
  if (userId) _agentUserCache.set(agentId, userId);
  return userId;
}

/** Wrap `next` so the remaining middleware/handler chain runs inside rlsStorage. */
function _nextWithRls(userId, next) {
  if (userId) {
    rlsStorage.run(userId, () => next());
  } else {
    next();
  }
}

/**
 * Require authentication
 * Validates token and attaches agent to req.agent
 */
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const token = extractToken(authHeader);
    
    if (!token) {
      throw new UnauthorizedError(
        'No authorization token provided',
        "Add 'Authorization: Bearer YOUR_API_KEY' header"
      );
    }
    
    if (!validateApiKey(token)) {
      throw new UnauthorizedError(
        'Invalid token format',
        'Token should start with "maavadao_" followed by 64 hex characters'
      );
    }
    
    const agent = await AgentService.findByApiKey(token);
    
    if (!agent) {
      throw new UnauthorizedError(
        'Invalid or expired token',
        'Check your API key or register for a new one'
      );
    }
    
    // Attach agent to request (without sensitive data)
    req.agent = {
      id: agent.id,
      name: agent.name,
      displayName: agent.display_name,
      description: agent.description,
      karma: agent.karma,
      status: agent.status,
      isClaimed: agent.is_claimed,
      subdomain: agent.subdomain,
      createdAt: agent.created_at
    };
    req.token = token;
    
    // Activate RLS context for the owning user
    const userId = await _resolveUserIdForAgent(agent.id);
    _nextWithRls(userId, next);
  } catch (error) {
    next(error);
  }
}

/**
 * Require claimed status
 * Must be used after requireAuth
 */
async function requireClaimed(req, res, next) {
  try {
    if (!req.agent) {
      throw new UnauthorizedError('Authentication required');
    }
    
    if (!req.agent.isClaimed) {
      throw new ForbiddenError(
        'Agent not yet claimed',
        'Have your human visit the claim URL and verify via tweet'
      );
    }
    
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Optional authentication
 * Attaches agent if token provided, but doesn't fail otherwise
 */
async function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const token = extractToken(authHeader);
    
    if (!token || !validateApiKey(token)) {
      req.agent = null;
      req.token = null;
      return next();
    }
    
    const agent = await AgentService.findByApiKey(token);
    
    if (agent) {
      req.agent = {
        id: agent.id,
        name: agent.name,
        displayName: agent.display_name,
        description: agent.description,
        karma: agent.karma,
        status: agent.status,
        isClaimed: agent.is_claimed,
        subdomain: agent.subdomain,
        createdAt: agent.created_at
      };
      req.token = token;

      const userId = await _resolveUserIdForAgent(agent.id);
      return _nextWithRls(userId, next);
    } else {
      req.agent = null;
      req.token = null;
    }
    
    next();
  } catch (error) {
    // On error, continue without auth
    req.agent = null;
    req.token = null;
    next();
  }
}

/**
 * Require user authentication
 * Validates token and attaches user to req.user
 */
async function requireUserAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const token = extractToken(authHeader);
    
    if (!token) {
      throw new UnauthorizedError(
        'No authorization token provided',
        "Add 'Authorization: Bearer YOUR_API_KEY' header"
      );
    }
    
    let user = null;

    if (validateApiKey(token)) {
      // Standard maavadao_ API key path
      user = await UserService.findByApiKey(token);
    } else {
      // Fall back to Go-auth JWT (OAuth users store their JWT as apiKey)
      const jwtPayload = verifyJWT(token);
      if (!jwtPayload) {
        throw new UnauthorizedError(
          'Invalid token format',
          'Token should start with "maavadao_" followed by 64 hex characters, or be a valid JWT'
        );
      }
      const userId = jwtPayload.userId || jwtPayload.sub;
      if (!userId) {
        throw new UnauthorizedError('Invalid token: missing user identity');
      }
      user = await UserService.findById(userId);
    }
    
    if (!user) {
      throw new UnauthorizedError(
        'Invalid or expired token',
        'Check your API key or register for a new one'
      );
    }
    
    // Attach user to request (without sensitive data)
    req.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.display_name,
      isVerified: user.is_verified,
      createdAt: user.created_at
    };
    req.token = token;
    
    // Activate RLS context for this user
    _nextWithRls(user.id, next);
  } catch (error) {
    next(error);
  }
}

/**
 * Optional user authentication
 * Attaches user if token provided, but doesn't fail otherwise
 */
async function optionalUserAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const token = extractToken(authHeader);
    
    if (!token || !validateApiKey(token)) {
      req.user = null;
      req.token = null;
      return next();
    }
    
    const user = await UserService.findByApiKey(token);
    
    if (user) {
      req.user = {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.display_name,
        isVerified: user.is_verified,
        createdAt: user.created_at
      };
      req.token = token;
      return _nextWithRls(user.id, next);
    } else {
      req.user = null;
      req.token = null;
    }
    
    next();
  } catch (error) {
    // On error, continue without auth
    req.user = null;
    req.token = null;
    next();
  }
}

/**
 * Require internal service authentication
 *
 * Validates `INTERNAL_API_SECRET` from the `Authorization: Bearer <secret>` header
 * and impersonates the user specified in the `X-User-ID` header.
 *
 * This enables the maava plugin (and other internal services) to call
 * seller endpoints on behalf of a specific user — without needing that user's JWT.
 *
 * Security:
 *   - The secret is compared in constant time to prevent timing attacks.
 *   - The impersonated user is verified to exist before proceeding.
 *   - RLS context is activated so all downstream DB queries are scoped.
 */
async function requireInternalAuth(req, res, next) {
  try {
    const config = require('../config');
    const secret = config.internalApiSecret;

    if (!secret) {
      // No internal secret configured — fall through to normal user auth
      return requireUserAuth(req, res, next);
    }

    const authHeader = req.headers.authorization;
    const token = extractToken(authHeader);

    if (!token) {
      throw new UnauthorizedError(
        'No authorization token provided',
        "Add 'Authorization: Bearer INTERNAL_API_SECRET' header"
      );
    }

    // Timing-safe comparison of the internal secret
    const { compareTokens } = require('../utils/auth');
    if (!compareTokens(token, secret)) {
      // Fall through to normal auth — this may be a regular user token
      return requireUserAuth(req, res, next);
    }

    // Internal secret matched — now resolve the impersonated user
    const userId = req.headers['x-user-id'];
    if (!userId) {
      throw new UnauthorizedError(
        'X-User-ID header is required for internal auth',
        'Include the target user UUID in the X-User-ID header'
      );
    }

    const user = await UserService.findById(userId);
    if (!user) {
      throw new UnauthorizedError(
        'Invalid X-User-ID: user not found',
        'Verify the user UUID is correct'
      );
    }

    // Attach user to request (same shape as requireUserAuth)
    req.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.display_name,
      isVerified: user.is_verified,
      createdAt: user.created_at
    };
    req.token = token;
    req.isInternalAuth = true;

    // Activate RLS context for the impersonated user
    _nextWithRls(user.id, next);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  requireAuth,
  requireClaimed,
  optionalAuth,
  requireUserAuth,
  optionalUserAuth,
  requireInternalAuth
};
