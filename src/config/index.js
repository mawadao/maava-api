/**
 * Application configuration
 */

require("dotenv").config();

const config = {
  // Server
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || "development",
  isProduction: process.env.NODE_ENV === "production",

  // Database
  database: {
    url: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes("sslmode=")
      ? { rejectUnauthorized: false }
      : process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : false,
  },

  // Redis (optional)
  redis: {
    url: process.env.REDIS_URL,
  },

  // Security
  jwtSecret:
    process.env.JWT_SECRET || "development-secret-change-in-production",

  // Internal service-to-service authentication (OpenClaw plugin → Barrsa API)
  internalApiSecret: process.env.INTERNAL_API_SECRET || "",

  // Rate Limits
  rateLimits: {
    requests: { max: 100, window: 60 },
    posts: { max: 1, window: 1800 },
    comments: { max: 50, window: 3600 },
    login: { max: 5, window: 900 },        // 5 attempts per 15 min
    registration: { max: 3, window: 3600 }, // 3 per hour
  },

  // CORS allowed origins (comma-separated; env CORS_ALLOWED_ORIGINS)
  corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS?.split(",").map((o) =>
    o.trim()
  ),

  // Moltbook specific
  moltbook: {
    tokenPrefix: "moltbook_",
    claimPrefix: "moltbook_claim_",
    baseUrl: process.env.BASE_URL || "https://www.moltbook.com",
  },

  // Pagination defaults
  pagination: {
    defaultLimit: 25,
    maxLimit: 100,
  },

  // Cloud Run agent runtime (deploy is in cloud-run-deployer repo)
  cloudRun: {
    // Shared multi-tenant service URL (agents register here)
    sharedServiceUrl:
      process.env.CLOUD_RUN_SHARED_SERVICE_URL ||
      "https://moltbook-agents-shared.example.run.app",
    // Base URL for dedicated services (e.g. https://agent-{id}.run.app or custom domain)
    dedicatedBaseUrl:
      process.env.CLOUD_RUN_DEDICATED_BASE_URL ||
      "https://moltbook-agent.example.run.app",
    // Cloud Run Deployer API URL
    deployerUrl:
      process.env.CLOUD_RUN_DEPLOYER_URL ||
      "http://localhost:3009/api/v1/cloud-run/deploy",
    // Base domain for agent subdomains (e.g. "moltbook.com" or "agents.moltbook.com")
    baseDomain:
      process.env.AGENT_BASE_DOMAIN ||
      "moltbook.com",
  },

  // Google Cloud Storage — platform-level file uploads (avatars, post images, etc.)
  storage: {
    projectId: process.env.GCP_PROJECT_ID || "barrsaai",
    bucket: process.env.GCS_PLATFORM_BUCKET || "barrsa-platform-assets",
    // Per-tenant bucket prefix (e.g. "barrsa-user-raj")
    tenantBucketPrefix: process.env.GCS_TENANT_BUCKET_PREFIX || "barrsa-user",
    // Max upload size in bytes (default 10 MB)
    maxFileSize: parseInt(process.env.MAX_UPLOAD_SIZE, 10) || 10 * 1024 * 1024,
    // CDN base URL for serving assets (optional — falls back to GCS public URL)
    cdnBaseUrl: process.env.CDN_BASE_URL || null,
  },

  // Zernio — unified social media API (posting, analytics, OAuth connect)
  zernio: {
    apiKey: process.env.ZERNIO_API_KEY || "",
    baseUrl: (process.env.ZERNIO_API_URL || "https://zernio.com/api/v1").replace(/\/+$/, ""),
    // Callback URL Barrsa hands to Zernio during OAuth connect flows
    callbackUrl: process.env.ZERNIO_CALLBACK_URL || "https://barrsa.com/seller/social-accounts/oauth-callback",
  },
};

// Validate required config
function validateConfig() {
  const required = [];

  if (config.isProduction) {
    required.push("DATABASE_URL", "JWT_SECRET");
  }

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }
}

validateConfig();

module.exports = config;
