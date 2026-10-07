/**
 * JWT Authentication middleware for cloud mode.
 *
 * Validates JWT tokens issued by the Go auth service.
 * Works alongside the existing API-key auth — routes can use either
 * requireAuth (API key) or requireJWTAuth (JWT) depending on context.
 */

const config = require("../config");
const { UnauthorizedError, ForbiddenError } = require("../utils/errors");

// Inline minimal JWT validation (HS256 only) to avoid adding jsonwebtoken dependency.
// mawaDao already has jwtSecret in config.
const crypto = require("crypto");

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

function verifyHS256(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(base64UrlDecode(headerB64).toString("utf8"));
  if (header.alg !== "HS256") return null;

  // Use timing-safe comparison to prevent timing attacks
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const actualSig = base64UrlDecode(signatureB64);

  if (expectedSig.length !== actualSig.length) return null;
  if (!crypto.timingSafeEqual(expectedSig, actualSig)) return null;

  const payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8"));

  // Check expiry
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

  // Validate issuer
  if (payload.iss && payload.iss !== "mawadao-auth") return null;

  return payload;
}

/**
 * Require JWT authentication.
 * Validates JWT from Authorization header or auth-token cookie.
 * Attaches decoded claims to req.jwtUser.
 */
async function requireJWTAuth(req, res, next) {
  try {
    // Extract token
    let token;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    }
    if (!token) {
      const cookieHeader = req.headers.cookie;
      if (cookieHeader) {
        const match = cookieHeader
          .split(";")
          .find((c) => c.trim().startsWith("auth-token="));
        if (match) {
          token = match.split("=")[1]?.trim();
        }
      }
    }

    if (!token) {
      throw new UnauthorizedError(
        "No authentication token provided",
        "Add 'Authorization: Bearer <jwt>' header or set auth-token cookie"
      );
    }

    // If token looks like an API key (mawadao_ prefix), reject — use requireAuth instead
    if (token.startsWith(config.mawadao.tokenPrefix)) {
      throw new UnauthorizedError(
        "Expected JWT token, not API key",
        "Use JWT authentication for this endpoint"
      );
    }

    const claims = verifyHS256(token, config.jwtSecret);
    if (!claims) {
      throw new UnauthorizedError(
        "Invalid or expired JWT",
        "Check your token or log in again"
      );
    }

    req.jwtUser = {
      userId: claims.sub || claims.userId || "",
      email: claims.email || "",
      subdomain: claims.subdomain || null,
      tenantId: claims.tenantId || null,
    };

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Optional JWT authentication.
 * Attaches jwtUser if valid token present, otherwise continues.
 */
async function optionalJWTAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    let token;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    }

    if (!token || token.startsWith(config.mawadao.tokenPrefix)) {
      req.jwtUser = null;
      return next();
    }

    const claims = verifyHS256(token, config.jwtSecret);
    if (claims) {
      req.jwtUser = {
        userId: claims.sub || claims.userId || "",
        email: claims.email || "",
        subdomain: claims.subdomain || null,
        tenantId: claims.tenantId || null,
      };
    } else {
      req.jwtUser = null;
    }
    next();
  } catch {
    req.jwtUser = null;
    next();
  }
}

module.exports = {
  requireJWTAuth,
  optionalJWTAuth,
};
