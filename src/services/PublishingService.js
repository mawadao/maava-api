/**
 * Publishing Service
 *
 * Manages the publishing pipeline: job creation, provider dispatch
 * (Zernio for social, internal for marketplace), result tracking, and retries.
 *
 * Provider abstraction: mawaDao owns the publishing orchestration;
 * Zernio is the unified social media backend.
 */

const { Storage } = require("@google-cloud/storage");
const crypto = require("crypto");
const { queryOne, queryAll, transaction } = require("../config/database");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} = require("../utils/errors");
const config = require("../config");
const { getZernioService, getZernioServiceForUser } = require("./ZernioService");

// GCS bucket where tenant workspace files are stored
const GCS_BUCKET = "mawa-data";
const gcsStorage = new Storage();

// Media proxy — HMAC-signed URLs served by mawa-api itself
const MEDIA_PROXY_SECRET =
  process.env.MEDIA_PROXY_SECRET ||
  process.env.JWT_SECRET ||
  "development-secret-change-in-production";
const CONFIG_API_BASE_URL =
  process.env.CONFIG_API_PUBLIC_URL ||
  "http://localhost:3003";

/**
 * Internal marketplace provider — publishes to mawaDao's own marketplace.
 * No external API call; just activates the product listing.
 */
class InternalMarketplaceProvider {
  async publish(product, listingOutput) {
    // Product is already in the DB — just mark it active.
    // The listing_output with channel='marketplace' is the source of truth.
    return {
      provider: "internal_marketplace",
      postId: product.id,
      postUrl: `/marketplace/products/${product.id}`,
      status: "success",
    };
  }
}

// ─── Provider Registry ────────────────────────────────────────────

function getProvider(providerName, userId) {
  if (providerName === "zernio") return getZernioService();
  if (providerName === "internal_marketplace") return new InternalMarketplaceProvider();
  throw new BadRequestError(`Unknown publishing provider: ${providerName}`);
}

// ─── Publishing Service ───────────────────────────────────────────

class PublishingService {
  /**
   * Create a publishing job and optionally dispatch it immediately.
   *
   * @param {Object} params
   * @param {string} params.userId
   * @param {string} params.productId
   * @param {string} [params.listingOutputId]
   * @param {string} [params.publishingTargetId]
   * @param {string} params.channel
   * @param {Date|string} [params.scheduledAt] - null = publish now
   */
  static async createJob({
    userId,
    productId,
    listingOutputId = null,
    publishingTargetId = null,
    channel,
    scheduledAt = null,
    metadata = {},
  }) {
    const idempotencyKey = `${userId}:${productId}:${channel}:${Date.now()}`;
    const status = scheduledAt ? "scheduled" : "pending";

    const job = await queryOne(
      `INSERT INTO publishing_jobs (
        user_id, product_id, listing_output_id, publishing_target_id,
        channel, status, scheduled_at, idempotency_key, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`,
      [
        userId,
        productId,
        listingOutputId,
        publishingTargetId,
        channel,
        status,
        scheduledAt || null,
        idempotencyKey,
        metadata,
      ]
    );

    return job;
  }

  /**
   * Dispatch a pending job to the appropriate provider.
   */
  static async dispatchJob(jobId) {
    const job = await queryOne(
      `SELECT pj.*,
              pt.target_type, pt.config AS target_config,
              csa.provider, csa.provider_account_id, csa.platform_account_id,
              csa.access_token_enc, csa.metadata AS account_metadata
       FROM publishing_jobs pj
       LEFT JOIN publishing_targets pt ON pj.publishing_target_id = pt.id
       LEFT JOIN connected_social_accounts csa ON pt.social_account_id = csa.id
       WHERE pj.id = $1`,
      [jobId]
    );

    if (!job) throw new NotFoundError("Publishing job");
    if (!["pending", "scheduled"].includes(job.status)) {
      throw new BadRequestError(`Job is already ${job.status}`);
    }

    // Mark as publishing
    await queryOne(
      `UPDATE publishing_jobs SET status = 'publishing' WHERE id = $1`,
      [jobId]
    );

    try {
      let result;

      if (job.channel === "internal_marketplace") {
        // Internal marketplace — just activate the product
        const product = await queryOne(
          `SELECT * FROM products WHERE id = $1`,
          [job.product_id]
        );
        await queryOne(
          `UPDATE products SET status = 'active' WHERE id = $1`,
          [job.product_id]
        );
        result = {
          provider: "internal_marketplace",
          postId: product.id,
          postUrl: `/marketplace/products/${product.id}`,
          status: "success",
        };
      } else if (job.provider === "zernio" || job.channel !== "internal_marketplace") {
        // Zernio social publishing
        result = await this._publishViaZernio(job);
      } else {
        throw new BadRequestError(
          `No provider configured for channel: ${job.channel}`
        );
      }

      // Record success
      await this._recordResult(jobId, result);
      await queryOne(
        `UPDATE publishing_jobs SET status = 'published', published_at = NOW() WHERE id = $1`,
        [jobId]
      );

      return result;
    } catch (error) {
      // Record failure and handle retries
      await this._handleFailure(jobId, error);
      throw error;
    }
  }

  /**
   * Convert a relative /api/media/workspace/ URL to a publicly-downloadable
   * HMAC-signed proxy URL served by mawa-api itself.
   * Non-relative URLs are returned unchanged.
   */
  static _resolveMediaUrl(url, userId) {
    if (!url || !url.startsWith("/api/media/workspace/")) return url;

    const filename = url.replace("/api/media/workspace/", "");
    const gcsPath = `${userId}/mountfolder/workspace/${filename}`;

    // 1-hour expiry
    const exp = Date.now() + 60 * 60 * 1000;
    const sig = crypto
      .createHmac("sha256", MEDIA_PROXY_SECRET)
      .update(`${gcsPath}:${exp}`)
      .digest("hex");

    return `${CONFIG_API_BASE_URL}/api/v1/media/serve?path=${encodeURIComponent(gcsPath)}&exp=${exp}&sig=${sig}`;
  }

  /**
   * Resolve all media item URLs in an array, converting relative paths
   * to publicly-downloadable proxy URLs so external APIs (Zernio) can fetch them.
   */
  static _resolveMediaItems(items, userId) {
    return items.map((item) => ({
      ...item,
      url: this._resolveMediaUrl(item.url, userId),
    }));
  }

  /**
   * Publish via Zernio unified social API.
   */
  static async _publishViaZernio(job) {
    if (!job.platform_account_id) {
      throw new BadRequestError(
        "No Zernio account ID for this social account. Please reconnect the account."
      );
    }

    const zernio = getZernioService();

    // Build content from the listing output
    let content = "";
    let mediaItems = [];
    let hashtags = [];

    if (job.listing_output_id) {
      const output = await queryOne(
        `SELECT * FROM listing_outputs WHERE id = $1`,
        [job.listing_output_id]
      );
      if (output) {
        const parts = [];
        if (output.title) parts.push(output.title);
        if (output.body) parts.push(output.body);
        if (output.cta) parts.push(`\n${output.cta}`);
        content = parts.join("\n\n");

        if (output.hashtags?.length) hashtags = output.hashtags;
        if (output.media_urls?.length) {
          mediaItems = output.media_urls.map((url) => ({ type: "image", url }));
        }
      }
    }

    // Fall back to any listing output for this product if none matched by channel
    if (!content && job.product_id) {
      const fallbackOutput = await queryOne(
        `SELECT * FROM listing_outputs WHERE product_id = $1 ORDER BY updated_at DESC LIMIT 1`,
        [job.product_id]
      );
      if (fallbackOutput) {
        const parts = [];
        if (fallbackOutput.title) parts.push(fallbackOutput.title);
        if (fallbackOutput.body) parts.push(fallbackOutput.body);
        if (fallbackOutput.cta) parts.push(`\n${fallbackOutput.cta}`);
        content = parts.join("\n\n");
        if (fallbackOutput.hashtags?.length) hashtags = fallbackOutput.hashtags;
        if (fallbackOutput.media_urls?.length) {
          mediaItems = fallbackOutput.media_urls.map((url) => ({ type: "image", url }));
        }
      }
    }

    // Fall back to product assets for media if listing has no media_urls
    if (mediaItems.length === 0 && job.product_id) {
      const assets = await queryAll(
        `SELECT file_url, mime_type FROM product_assets
         WHERE product_id = $1 AND asset_type IN ('image', 'thumbnail', 'mockup', 'promo_card')
         ORDER BY sort_order ASC, created_at ASC`,
        [job.product_id]
      );
      if (assets.length > 0) {
        mediaItems = assets.map((a) => ({ type: "image", url: a.file_url }));
      }
    }

    // Last resort: use product name/description as content
    if (!content && job.product_id) {
      const product = await queryOne(
        `SELECT name, description FROM products WHERE id = $1`,
        [job.product_id]
      );
      if (product) {
        const parts = [];
        if (product.name) parts.push(product.name);
        if (product.description) parts.push(product.description);
        content = parts.join("\n\n");
      }
    }

    if (!content) {
      throw new BadRequestError("No content to publish. Generate a listing first.");
    }

    const platform = job.target_type || job.channel;

    // Instagram requires at least one image — fail early with a clear message
    if (platform === 'instagram' && mediaItems.length === 0) {
      throw new BadRequestError(
        'Instagram requires at least one image. Please add images to your product before publishing.'
      );
    }

    // Resolve relative media URLs to publicly-downloadable proxy URLs
    if (mediaItems.length > 0) {
      mediaItems = this._resolveMediaItems(mediaItems, job.user_id);
    }

    const result = await zernio.createPost({
      platforms: [
        {
          platform,
          accountId: job.platform_account_id,
        },
      ],
      content,
      mediaItems,
      hashtags,
      scheduledFor: job.scheduled_at || null,
      publishNow: !job.scheduled_at,
    });

    const platformResult = result.post?.platforms?.[0] || {};

    return {
      provider: "zernio",
      providerPostId: result.post?._id || null,
      platformPostId: platformResult.platformPostId || null,
      postUrl: platformResult.platformPostUrl || null,
      platform,
      status: "success",
      responseData: result,
    };
  }

  /**
   * Record a publishing result.
   */
  static async _recordResult(jobId, result) {
    return queryOne(
      `INSERT INTO publishing_results (
        publishing_job_id, provider, provider_post_id, platform_post_id,
        post_url, platform, status, response_data
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`,
      [
        jobId,
        result.provider || null,
        result.providerPostId || result.postId || null,
        result.platformPostId || null,
        result.postUrl || null,
        result.platform || null,
        result.status || "success",
        result.responseData || result,
      ]
    );
  }

  /**
   * Handle a publishing failure — increment retry count or mark as failed.
   */
  static async _handleFailure(jobId, error) {
    const job = await queryOne(
      `SELECT id, retry_count, max_retries FROM publishing_jobs WHERE id = $1`,
      [jobId]
    );

    const newRetryCount = (job.retry_count || 0) + 1;
    const isFinal = newRetryCount >= (job.max_retries || 3);

    await queryOne(
      `UPDATE publishing_jobs
       SET status = $1, retry_count = $2, last_error = $3
       WHERE id = $4`,
      [
        isFinal ? "failed" : "pending",
        newRetryCount,
        error.message || String(error),
        jobId,
      ]
    );

    // Record the failure result
    await queryOne(
      `INSERT INTO publishing_results (
        publishing_job_id, provider, status, error_code, error_message, response_data
      ) VALUES ($1, $2, 'failed', $3, $4, $5)`,
      [
        jobId,
        "zernio",
        error.code || error.status || null,
        error.message || String(error),
        error.providerResponse || {},
      ]
    );
  }

  // ─── Job Queries ──────────────────────────────────────────────────

  static async getJob(jobId) {
    const job = await queryOne(
      `SELECT pj.*,
              p.name AS product_name,
              lo.channel AS output_channel, lo.title AS output_title
       FROM publishing_jobs pj
       LEFT JOIN products p ON pj.product_id = p.id
       LEFT JOIN listing_outputs lo ON pj.listing_output_id = lo.id
       WHERE pj.id = $1`,
      [jobId]
    );
    if (!job) throw new NotFoundError("Publishing job");
    return job;
  }

  static async listJobs(userId, { status = null, productId = null, limit = 25, offset = 0 } = {}) {
    const conditions = ["pj.user_id = $1"];
    const values = [userId];
    let idx = 2;

    if (status) {
      conditions.push(`pj.status = $${idx}`);
      values.push(status);
      idx++;
    }
    if (productId) {
      conditions.push(`pj.product_id = $${idx}`);
      values.push(productId);
      idx++;
    }

    values.push(limit, offset);
    return queryAll(
      `SELECT pj.*,
              p.name AS product_name,
              lo.channel AS output_channel, lo.title AS output_title
       FROM publishing_jobs pj
       LEFT JOIN products p ON pj.product_id = p.id
       LEFT JOIN listing_outputs lo ON pj.listing_output_id = lo.id
       WHERE ${conditions.join(" AND ")}
       ORDER BY pj.created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    );
  }

  static async getJobResults(jobId) {
    return queryAll(
      `SELECT * FROM publishing_results WHERE publishing_job_id = $1 ORDER BY created_at ASC`,
      [jobId]
    );
  }

  static async cancelJob(jobId, userId) {
    const job = await queryOne(
      `SELECT id, user_id, status FROM publishing_jobs WHERE id = $1`,
      [jobId]
    );
    if (!job) throw new NotFoundError("Publishing job");
    if (job.user_id !== userId) throw new ForbiddenError("Not your job");
    if (!["pending", "scheduled"].includes(job.status)) {
      throw new BadRequestError(`Cannot cancel a ${job.status} job`);
    }

    return queryOne(
      `UPDATE publishing_jobs SET status = 'cancelled' WHERE id = $1 RETURNING *`,
      [jobId]
    );
  }

  // ─── Scheduled Job Processor ──────────────────────────────────────

  /**
   * Process due scheduled jobs. Called by a cron/scheduler.
   * Returns the number of jobs dispatched.
   */
  static async processDueJobs() {
    const dueJobs = await queryAll(
      `SELECT id FROM publishing_jobs
       WHERE status = 'scheduled'
         AND scheduled_at IS NOT NULL
         AND scheduled_at <= NOW()
       ORDER BY scheduled_at ASC
       LIMIT 50`
    );

    let dispatched = 0;
    for (const job of dueJobs) {
      try {
        await this.dispatchJob(job.id);
        dispatched++;
      } catch (err) {
        console.error(`Failed to dispatch job ${job.id}:`, err.message);
      }
    }
    return dispatched;
  }

  /**
   * Retry failed jobs that haven't exhausted retries.
   */
  static async retryFailedJobs() {
    const retryable = await queryAll(
      `SELECT id FROM publishing_jobs
       WHERE status = 'pending'
         AND retry_count > 0
         AND retry_count < max_retries
       ORDER BY updated_at ASC
       LIMIT 20`
    );

    let retried = 0;
    for (const job of retryable) {
      try {
        await this.dispatchJob(job.id);
        retried++;
      } catch (err) {
        console.error(`Retry failed for job ${job.id}:`, err.message);
      }
    }
    return retried;
  }

  // ─── Multi-channel publish helper ─────────────────────────────────

  /**
   * Publish a product to multiple channels at once.
   * Creates one job per target and dispatches them.
   */
  static async publishToMultipleTargets(userId, productId, targetIds, { scheduledAt = null } = {}) {
    const results = [];

    for (const targetId of targetIds) {
      const target = await queryOne(
        `SELECT pt.*, csa.platform
         FROM publishing_targets pt
         LEFT JOIN connected_social_accounts csa ON pt.social_account_id = csa.id
         WHERE pt.id = $1 AND pt.user_id = $2`,
        [targetId, userId]
      );
      if (!target) continue;

      // Find the matching listing output
      const channel = target.target_type || target.platform || "marketplace";
      const output = await queryOne(
        `SELECT id FROM listing_outputs
         WHERE product_id = $1 AND channel = $2
         ORDER BY updated_at DESC LIMIT 1`,
        [productId, channel]
      );

      const job = await this.createJob({
        userId,
        productId,
        listingOutputId: output?.id || null,
        publishingTargetId: targetId,
        channel,
        scheduledAt,
      });

      if (!scheduledAt) {
        try {
          const result = await this.dispatchJob(job.id);
          results.push({ jobId: job.id, channel, status: "published", result });
        } catch (err) {
          results.push({ jobId: job.id, channel, status: "failed", error: err.message });
        }
      } else {
        results.push({ jobId: job.id, channel, status: "scheduled" });
      }
    }

    return results;
  }
}

module.exports = PublishingService;
