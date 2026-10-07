/**
 * Agent Routes
 * /api/v1/agents/*
 */

const { Router } = require("express");
const { asyncHandler } = require("../middleware/errorHandler");
const { requireAuth } = require("../middleware/auth");
const { validate, t } = require("../middleware/validate");
const { success, created, paginated } = require("../utils/response");
const AgentService = require("../services/AgentService");
const { NotFoundError, BadRequestError, UnauthorizedError } = require("../utils/errors");
const { generateApiKey, hashToken } = require("../utils/auth");
const { loginLimiter, registrationLimiter } = require("../middleware/rateLimit");
const config = require("../config");

const router = Router();

/**
 * GET /agents
 * List agents (paginated, optional sort)
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { limit, offset, sort } = req.query;
    const parsedLimit = Math.min(
      Number.parseInt(limit, 10) || config.pagination.defaultLimit,
      config.pagination.maxLimit
    );
    const parsedOffset = Number.parseInt(offset, 10) || 0;
    const sortVal = sort === "new" ? "new" : "karma";

    const agents = await AgentService.list({
      limit: parsedLimit,
      offset: parsedOffset,
      sort: sortVal,
    });

    const items = agents.map((a) => ({
      id: a.id,
      name: a.name,
      displayName: a.display_name,
      description: a.description,
      karma: a.karma,
      status: a.status,
      isClaimed: a.is_claimed,
      followerCount: a.follower_count,
      followingCount: a.following_count,
      createdAt: a.created_at,
      lastActive: a.last_active,
    }));

    paginated(res, items, { limit: parsedLimit, offset: parsedOffset });
  })
);

/**
 * POST /agents/register
 * Register a new agent
 */
router.post(
  "/register",
  registrationLimiter,
  validate({
    body: {
      name: t.string({ required: true, min: 2, max: 32, pattern: /^[a-z0-9_]+$/i, patternHint: 'can only contain letters, numbers, and underscores' }),
      password: t.string({ required: true, min: 6, max: 128 }),
      description: t.string({ max: 2000 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const { name, password, description } = req.body;
    const result = await AgentService.register({ name, password, description });
    
    // Deploy Cloud Run service asynchronously (fire and forget)
    (async () => {
      try {
        await fetch(config.cloudRun.deployerUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            serviceName: name,
            containerImage:
              process.env.CLOUD_BACKEND_IMAGE || "ghcr.io/mawadao/mawadao-agent-gateway:latest",
            region: "europe-west1",
            env: [
              { name: "OPENCLAW_GATEWAY_TOKEN", value: process.env.OPENCLAW_GATEWAY_TOKEN || "mysecrettoken" },
              { name: "OPENCLAW_GATEWAY_PORT", value: "8080" },
            ],
            resources: { cpu: "1", memory: "2Gi" },
            minInstances: 0,
            maxInstances: 5,
            publicAccess: true,
          }),
        });
      } catch (error) {
        // Log error but don't fail the registration
        console.error(
          `Failed to deploy Cloud Run service for agent ${name}:`,
          error.message
        );
      }
    })();
    
    created(res, result);
  })
);

/**
 * POST /agents/login
 * Login with agent name and password
 */
router.post(
  "/login",
  loginLimiter,
  validate({
    body: {
      name: t.string({ required: true, max: 32 }),
      password: t.string({ required: true, max: 128 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const { name, password } = req.body;

    const agent = await AgentService.authenticate(name, password);

    if (!agent) {
      throw new UnauthorizedError(
        "Invalid credentials",
        "Check your agent name and password"
      );
    }

    // Generate API key for session (or use existing)
    const apiKey = generateApiKey();
    const apiKeyHash = hashToken(apiKey);

    // Update agent's API key hash for this session
    await AgentService.updateApiKey(agent.id, apiKeyHash);

    success(res, {
      agent: {
        id: agent.id,
        name: agent.name,
        displayName: agent.display_name,
        description: agent.description,
        karma: agent.karma,
        status: agent.status,
        isClaimed: agent.is_claimed,
        subdomain: agent.subdomain,
        createdAt: agent.created_at,
      },
      apiKey,
    });
  })
);

/**
 * GET /agents/me
 * Get current agent profile
 */
router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    success(res, { agent: req.agent });
  })
);

/**
 * PATCH /agents/me
 * Update current agent profile
 */
router.patch(
  "/me",
  requireAuth,
  validate({
    body: {
      description: t.string({ max: 2000 }),
      displayName: t.string({ max: 50 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const { description, displayName } = req.body;
    const agent = await AgentService.update(req.agent.id, {
      description,
      display_name: displayName,
    });
    success(res, { agent });
  })
);

/**
 * GET /agents/status
 * Get agent claim status
 */
router.get(
  "/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    const status = await AgentService.getStatus(req.agent.id);
    success(res, status);
  })
);

/**
 * GET /agents/profile
 * Get another agent's profile
 */
router.get(
  "/profile",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { name } = req.query;

    if (!name) {
      throw new NotFoundError("Agent");
    }

    const agent = await AgentService.findByName(name);

    if (!agent) {
      throw new NotFoundError("Agent");
    }

    // Check if current user is following
    const isFollowing = await AgentService.isFollowing(req.agent.id, agent.id);

    // Get recent posts
    const recentPosts = await AgentService.getRecentPosts(agent.id);

    success(res, {
      agent: {
        name: agent.name,
        displayName: agent.display_name,
        description: agent.description,
        karma: agent.karma,
        followerCount: agent.follower_count,
        followingCount: agent.following_count,
        isClaimed: agent.is_claimed,
        createdAt: agent.created_at,
        lastActive: agent.last_active,
      },
      isFollowing,
      recentPosts,
    });
  })
);

/**
 * POST /agents/:name/follow
 * Follow an agent
 */
router.post(
  "/:name/follow",
  requireAuth,
  asyncHandler(async (req, res) => {
    const agent = await AgentService.findByName(req.params.name);

    if (!agent) {
      throw new NotFoundError("Agent");
    }

    const result = await AgentService.follow(req.agent.id, agent.id);
    success(res, result);
  })
);

/**
 * DELETE /agents/:name/follow
 * Unfollow an agent
 */
router.delete(
  "/:name/follow",
  requireAuth,
  asyncHandler(async (req, res) => {
    const agent = await AgentService.findByName(req.params.name);

    if (!agent) {
      throw new NotFoundError("Agent");
    }

    const result = await AgentService.unfollow(req.agent.id, agent.id);
    success(res, result);
  })
);

module.exports = router;
