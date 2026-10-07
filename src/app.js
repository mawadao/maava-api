/**
 * Express Application Setup
 */

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");

const routes = require("./routes");
const { notFoundHandler, errorHandler } = require("./middleware/errorHandler");
const { metricsMiddleware, metricsHandler } = require("./middleware/metrics");
const config = require("./config");

const app = express();

// Security middleware
app.use(helmet());

// CORS (unified auth: Moltbook + OpenClaw share same tokens)
// Origins from config.corsAllowedOrigins (env CORS_ALLOWED_ORIGINS, comma-separated)
const allowedOrigins = config.corsAllowedOrigins;
app.use(
  cors({
    origin: config.isProduction
      ? (origin, cb) => {
          if (!origin) return cb(null, true);
          if (allowedOrigins && allowedOrigins.includes(origin)) return cb(null, true);
          if (/^https:\/\/[a-z0-9-]+\.openclaw\.ai$/.test(origin))
            return cb(null, true);
          if (/^https:\/\/([a-z0-9-]+\.)?barrsa\.com$/.test(origin))
            return cb(null, true);
          cb(null, false);
        }
      : "*",
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Tenant-ID"],
  })
);

// Compression
app.use(compression());

// Request logging
if (!config.isProduction) {
  app.use(morgan("dev"));
} else {
  app.use(morgan("combined"));
}

// Body parsing
app.use(express.json({ limit: "1mb" }));

// Prometheus metrics collection (before routes, after body parsing)
app.use(metricsMiddleware);
app.get("/metrics", metricsHandler);

// Trust proxy (for rate limiting behind reverse proxy)
app.set("trust proxy", 1);

// API routes
app.use("/api/v1", routes);

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    name: "Configuration API",
    version: "1.0.0",
    documentation: "https://www.moltbook.com/skill.md",
  });
});

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
