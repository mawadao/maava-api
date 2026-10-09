/**
 * User Routes
 * /api/v1/users/*
 */

const { Router } = require("express");
const { asyncHandler } = require("../middleware/errorHandler");
const { requireUserAuth } = require("../middleware/auth");
const { validate, t } = require("../middleware/validate");
const { success, created } = require("../utils/response");
const UserService = require("../services/UserService");
const WaitlistService = require("../services/WaitlistService");
const { BadRequestError, UnauthorizedError, ForbiddenError } = require("../utils/errors");
const { generateApiKey, hashToken } = require("../utils/auth");
const { loginLimiter, registrationLimiter } = require("../middleware/rateLimit");
const config = require("../config");

const router = Router();

// ---------------------------------------------------------------------------
// Admin middleware — checks X-Admin-Secret header
// ---------------------------------------------------------------------------
function requireAdmin(req, res, next) {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    return res.status(503).json({ success: false, error: 'Admin access is not configured (ADMIN_SECRET not set)' });
  }
  const provided = req.headers['x-admin-secret'];
  if (!provided || provided !== adminSecret) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  next();
}

/**
 * POST /users/register
 * Register a new user account (open signup — no waitlist gate).
 * Fire-and-forget: triggers tenant Cloud Run deploy after the DB insert.
 */
router.post(
  "/register",
  registrationLimiter,
  validate({
    body: {
      username: t.string({ required: true, min: 3, max: 32, pattern: /^[a-z0-9_]+$/i, patternHint: 'can only contain letters, numbers, and underscores' }),
      email: t.string({ required: true, max: 254 }),
      password: t.string({ required: true, min: 6, max: 128 }),
      displayName: t.string({ max: 50 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const { username, email, password, displayName } = req.body;
    const result = await UserService.register({ username, email, password, displayName });

    // Fire-and-forget: deploy a per-user Cloud Run service.
    (async () => {
      try {
        const deployerUrl = config.cloudRun && config.cloudRun.deployerUrl;
        if (!deployerUrl) {
          console.warn(`[register] DEPLOYER_URL not configured; skipping tenant deploy for ${result.user.username}`);
          return;
        }
        const headers = { "Content-Type": "application/json" };
        if (process.env.DEPLOYER_API_SECRET) {
          headers["x-deployer-secret"] = process.env.DEPLOYER_API_SECRET;
        }
        const r = await fetch(deployerUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            serviceName: result.user.username,
            containerImage:
              process.env.CLOUD_BACKEND_IMAGE ||
              "ghcr.io/maavadao/maava-gateway:latest",
            region: "europe-west1",
            env: [
              { name: "OPENCLAW_GATEWAY_TOKEN", value: process.env.OPENCLAW_GATEWAY_TOKEN || "mysecrettoken" },
              { name: "OPENCLAW_GATEWAY_PORT", value: "8080" },
              { name: "TENANT_USER_ID", value: result.user.id },
              { name: "TENANT_USERNAME", value: result.user.username },
            ],
            resources: { cpu: "1", memory: "2Gi" },
            minInstances: 0,
            maxInstances: 5,
            publicAccess: true,
          }),
        });
        if (!r.ok) {
          const body = await r.text().catch(() => "");
          console.error(`[register] Deployer responded ${r.status} for ${result.user.username}: ${body}`);
        }
      } catch (error) {
        console.error(`[register] Failed to deploy Cloud Run service for ${result.user.username}:`, error.message);
      }
    })();

    created(res, result);
  })
);

/**
 * POST /users/login
 * Login with username/email and password
 */
router.post(
  "/login",
  loginLimiter,
  validate({
    body: {
      identifier: t.string({ required: true, max: 254 }),
      password: t.string({ required: true, max: 128 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const { identifier, password } = req.body;

    const user = await UserService.authenticate(identifier, password);

    if (!user) {
      throw new UnauthorizedError(
        "Invalid credentials",
        "Check your username/email and password"
      );
    }

    // Generate API key for session (or use existing)
    const apiKey = generateApiKey();
    const apiKeyHash = hashToken(apiKey);

    // Update user's API key hash for this session
    await UserService.updateApiKey(user.id, apiKeyHash);

    success(res, {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.display_name,
        isVerified: user.is_verified,
        createdAt: user.created_at,
      },
      apiKey,
    });
  })
);

/**
 * GET /users/me
 * Get current user profile
 */
router.get(
  "/me",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    success(res, { user: req.user });
  })
);

/**
 * PATCH /users/me
 * Update current user profile
 */
router.patch(
  "/me",
  requireUserAuth,
  validate({
    body: {
      displayName: t.string({ max: 50 }),
      avatarUrl: t.url(),
    },
  }),
  asyncHandler(async (req, res) => {
    const { displayName, avatarUrl } = req.body;
    const user = await UserService.update(req.user.id, {
      display_name: displayName,
      avatar_url: avatarUrl,
    });
    success(res, { user });
  })
);

// ---------------------------------------------------------------------------
// Waitlist status — public (used to gate OAuth logins)
// ---------------------------------------------------------------------------

/**
 * GET /users/waitlist/status?email=...
 * Returns the waitlist status for a given email.
 * Response: { status: 'pending' | 'approved' | 'rejected' | 'not_found' }
 */
router.get(
  "/waitlist/status",
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { email } = req.query;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ success: false, error: 'email query param is required' });
    }
    const status = await WaitlistService.getStatusByEmail(email);
    success(res, { status });
  })
);

/**
 * POST /users/waitlist/oauth-join
 * Auto-enroll an OAuth user (Google/Microsoft) onto the waitlist.
 * The user already authenticated — we just need to capture their interest.
 * Body: { email: string, displayName?: string }
 * Response: { status: 'pending' | 'approved' | 'rejected' }
 */
router.post(
  "/waitlist/oauth-join",
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { email, displayName } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ success: false, error: 'email is required' });
    }
    const status = await WaitlistService.addOAuthUserToWaitlist(email, displayName || '');
    success(res, { status });
  })
);

// ---------------------------------------------------------------------------
// Admin — Waitlist management (requires X-Admin-Secret header)
// ---------------------------------------------------------------------------

/**
 * GET /users/admin/waitlist
 * List all waitlist entries. Optional ?status=pending|approved|rejected filter.
 */
router.get(
  "/admin/waitlist",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { status } = req.query;
    const allowed = ['pending', 'approved', 'rejected'];
    const filter = allowed.includes(status) ? status : undefined;
    const entries = await WaitlistService.listWaitlist({ status: filter });
    success(res, { entries, total: entries.length });
  })
);

/**
 * POST /users/admin/waitlist/:id/approve
 * Approve a waitlist entry — creates user account + sends welcome email.
 */
router.post(
  "/admin/waitlist/:id/approve",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const user = await WaitlistService.approve(id);
    success(res, { user, message: 'User account created and welcome email sent.' });
  })
);

/**
 * POST /users/admin/waitlist/:id/reject
 * Reject a waitlist entry — sends polite decline email.
 * Optional body: { notes: "..." }
 */
router.post(
  "/admin/waitlist/:id/reject",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { notes } = req.body || {};
    const result = await WaitlistService.reject(id, { notes });
    success(res, { ...result, message: 'Entry rejected and decline email sent.' });
  })
);

module.exports = router;

