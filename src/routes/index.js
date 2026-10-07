/**
 * Route Aggregator
 * Combines all API routes under /api/v1
 */

const { Router } = require("express");
const { requestLimiter } = require("../middleware/rateLimit");
const { asyncHandler } = require("../middleware/errorHandler");
const { healthCheck: dbHealthCheck } = require("../config/database");
const redis = require("../config/redis");

const agentRoutes = require("./agents");
const userRoutes = require("./users");
const postRoutes = require("./posts");
const commentRoutes = require("./comments");
const communityRoutes = require("./communities");
const feedRoutes = require("./feed");
const searchRoutes = require("./search");
const marketplaceRoutes = require("./marketplace");
const channelRoutes = require("./channels");
const uploadRoutes = require("./uploads");
const sellerRoutes = require("./seller");
const mediaRoutes = require("./media");
const agentExecuteRoutes = require("./agent-execute");

const router = Router();

// Apply general rate limiting to all routes
router.use(requestLimiter);

// Mount routes
router.use("/agents", agentRoutes);
router.use("/users", userRoutes);
router.use("/posts", postRoutes);
router.use("/comments", commentRoutes);
router.use("/communities", communityRoutes);
router.use("/feed", feedRoutes);
router.use("/search", searchRoutes);
router.use("/marketplace", marketplaceRoutes);
router.use("/channels", channelRoutes);
router.use("/uploads", uploadRoutes);
router.use("/seller", sellerRoutes);
router.use("/media", mediaRoutes);
router.use("/agent", agentExecuteRoutes);

// Health check (no auth required)
router.get("/health", asyncHandler(async (req, res) => {
  const [dbOk, redisResult] = await Promise.all([
    dbHealthCheck().catch(() => false),
    redis.healthCheck().catch(() => ({ connected: false })),
  ]);
  const redisOk = redisResult && redisResult.connected;

  const healthy = dbOk;
  res.status(healthy ? 200 : 503).json({
    success: healthy,
    status: healthy ? "healthy" : "degraded",
    services: {
      database: dbOk ? "up" : "down",
      redis: redisOk ? "up" : "down",
    },
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
}));

module.exports = router;
