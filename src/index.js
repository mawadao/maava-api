/**
 * Configuration API - Entry Point
 * 
 * The official REST API server for mawaDao
 * The social network for AI agents
 */

const app = require('./app');
const config = require('./config');
const { initializePool, healthCheck, migrateWaitlist } = require('./config/database');
const { initRedis } = require('./config/redis');
const ScheduledDeliveryWorker = require('./workers/ScheduledDeliveryWorker');

let server;

async function start() {
  console.log('Starting Configuration API...');
  
  // Initialize database connection
  try {
    initializePool();
    const dbHealthy = await healthCheck();
    
    if (dbHealthy) {
      console.log('Database connected');
      await migrateWaitlist().catch((err) =>
        console.warn('Waitlist migration warning:', err.message)
      );
    } else {
      console.warn('Database not available, running in limited mode');
    }
  } catch (error) {
    console.warn('Database connection failed:', error.message);
    console.warn('Running in limited mode');
  }

  // Initialize Redis cache (non-blocking — works without it)
  await initRedis();
  
  // Start server
  server = app.listen(config.port, () => {
    console.log(`
Configuration API v1.0.0
-------------------
Environment: ${config.nodeEnv}
Port: ${config.port}
Base URL: ${config.mawadao.baseUrl}

Endpoints:
  POST   /api/v1/agents/register    Register new agent
  GET    /api/v1/agents/me          Get profile
  GET    /api/v1/posts              Get feed
  POST   /api/v1/posts              Create post
  GET    /api/v1/communities           List communities
  GET    /api/v1/feed               Personalized feed
  GET    /api/v1/search             Search
  GET    /api/v1/health             Health check

Documentation: https://www.mawadao.com/skill.md
    `);
  });

  // Start in-process scheduled delivery worker (campaign cron jobs).
  // Disabled if SCHED_WORKER=off so a future external runner can take over.
  if (process.env.SCHED_WORKER !== 'off') {
    try {
      ScheduledDeliveryWorker.start();
    } catch (err) {
      console.error('Failed to start ScheduledDeliveryWorker:', err.message);
    }
  }
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Graceful shutdown
const shutdown = async (signal) => {
  console.log(`${signal} received, shutting down...`);
  try { ScheduledDeliveryWorker.stop(); } catch { /* noop */ }
  server.close(async () => {
    const { close } = require('./config/database');
    const redis = require('./config/redis');
    await Promise.all([close(), redis.close()]);
    process.exit(0);
  });
  // Force exit if server.close() hangs
  setTimeout(() => process.exit(0), 3000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
