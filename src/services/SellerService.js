/**
 * Seller Service
 *
 * Business logic for seller profiles, products, product versions,
 * listing outputs, assets, approvals, and the complete seller workflow.
 */

const { queryOne, queryAll, transaction, rlsStorage, tenantTransaction } = require("../config/database");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} = require("../utils/errors");

class SellerService {
  // ─── Seller Categories ────────────────────────────────────────────

  static async listCategories() {
    return queryAll(
      `SELECT id, slug, name, description, parent_id, sort_order, is_active
       FROM seller_categories
       WHERE is_active = true
       ORDER BY sort_order ASC, name ASC`
    );
  }

  // ─── Seller Profiles ─────────────────────────────────────────────

  static async getProfileByUserId(userId) {
    return queryOne(
      `SELECT sp.*, sc.slug AS category_slug, sc.name AS category_name
       FROM seller_profiles sp
       LEFT JOIN seller_categories sc ON sp.category_id = sc.id
       WHERE sp.user_id = $1`,
      [userId]
    );
  }

  static async createProfile(userId, data) {
    const existing = await queryOne(
      `SELECT id FROM seller_profiles WHERE user_id = $1`,
      [userId]
    );
    if (existing) {
      throw new ConflictError("Seller profile already exists for this user");
    }

    if (data.categoryId) {
      const cat = await queryOne(
        `SELECT id FROM seller_categories WHERE id = $1 AND is_active = true`,
        [data.categoryId]
      );
      if (!cat) throw new BadRequestError("Invalid category");
    }

    return queryOne(
      `INSERT INTO seller_profiles (
        user_id, category_id, business_name, brand_voice, tagline,
        target_audience, default_cta, approval_required, timezone,
        logo_url, website_url, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *`,
      [
        userId,
        data.categoryId || null,
        data.businessName || null,
        data.brandVoice || null,
        data.tagline || null,
        data.targetAudience || null,
        data.defaultCta || null,
        data.approvalRequired !== undefined ? data.approvalRequired : true,
        data.timezone || "UTC",
        data.logoUrl || null,
        data.websiteUrl || null,
        data.metadata || {},
      ]
    );
  }

  static async updateProfile(userId, data) {
    const profile = await this.getProfileByUserId(userId);
    if (!profile) throw new NotFoundError("Seller profile");

    const fields = [];
    const values = [];
    let idx = 1;

    const allowedFields = {
      categoryId: "category_id",
      businessName: "business_name",
      brandVoice: "brand_voice",
      tagline: "tagline",
      targetAudience: "target_audience",
      defaultCta: "default_cta",
      approvalRequired: "approval_required",
      autoPublishChannels: "auto_publish_channels",
      timezone: "timezone",
      logoUrl: "logo_url",
      websiteUrl: "website_url",
      metadata: "metadata",
      onboardingCompleted: "onboarding_completed",
    };

    for (const [jsKey, dbCol] of Object.entries(allowedFields)) {
      if (data[jsKey] !== undefined) {
        fields.push(`${dbCol} = $${idx}`);
        values.push(data[jsKey]);
        idx++;
      }
    }

    if (fields.length === 0) {
      return profile;
    }

    values.push(profile.id);
    return queryOne(
      `UPDATE seller_profiles SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
      values
    );
  }

  static async completeOnboarding(userId) {
    return this.updateProfile(userId, { onboardingCompleted: true });
  }

  // ─── Products ─────────────────────────────────────────────────────

  static async createProduct(userId, data) {
    const profile = await this.getProfileByUserId(userId);
    if (!profile) {
      throw new BadRequestError(
        "Complete seller onboarding before creating products",
        "ONBOARDING_REQUIRED"
      );
    }

    return queryOne(
      `INSERT INTO products (
        user_id, seller_profile_id, category_id, name, summary,
        description, price, pricing_model, currency, deliverables,
        target_audience, tags, status, metadata, product_type
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *`,
      [
        userId,
        profile.id,
        data.categoryId || profile.category_id || null,
        data.name,
        data.summary || null,
        data.description || null,
        data.price || null,
        data.pricingModel || "one_time",
        data.currency || "USD",
        data.deliverables || [],
        data.targetAudience || profile.target_audience || null,
        data.tags || [],
        "draft",
        data.metadata || {},
        data.productType || "digital",
      ]
    );
  }

  static async getProduct(productId) {
    const product = await queryOne(
      `SELECT p.*,
              sp.business_name AS seller_business_name,
              sp.brand_voice AS seller_brand_voice,
              sc.slug AS category_slug,
              sc.name AS category_name
       FROM products p
       LEFT JOIN seller_profiles sp ON p.seller_profile_id = sp.id
       LEFT JOIN seller_categories sc ON p.category_id = sc.id
       WHERE p.id = $1`,
      [productId]
    );
    if (!product) throw new NotFoundError("Product");
    return product;
  }

  static async listProducts(userId, { limit = 25, offset = 0, status = null } = {}) {
    const conditions = ["p.user_id = $1"];
    const values = [userId];
    let idx = 2;

    if (status) {
      conditions.push(`p.status = $${idx}`);
      values.push(status);
      idx++;
    }

    values.push(limit, offset);
    return queryAll(
      `SELECT p.*,
              sc.slug AS category_slug,
              sc.name AS category_name,
              (SELECT COUNT(*) FROM product_versions pv WHERE pv.product_id = p.id) AS version_count,
              (SELECT COUNT(*) FROM product_assets pa WHERE pa.product_id = p.id) AS asset_count
       FROM products p
       LEFT JOIN seller_categories sc ON p.category_id = sc.id
       WHERE ${conditions.join(" AND ")}
       ORDER BY p.updated_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    );
  }

  static async updateProduct(productId, userId, data) {
    const product = await queryOne(
      `SELECT id, user_id, status FROM products WHERE id = $1`,
      [productId]
    );
    if (!product) throw new NotFoundError("Product");
    if (product.user_id !== userId) throw new ForbiddenError("Not your product");

    const fields = [];
    const values = [];
    let idx = 1;

    const allowedFields = {
      name: "name",
      summary: "summary",
      description: "description",
      price: "price",
      pricingModel: "pricing_model",
      currency: "currency",
      deliverables: "deliverables",
      targetAudience: "target_audience",
      tags: "tags",
      status: "status",
      categoryId: "category_id",
      productType: "product_type",
      metadata: "metadata",
    };

    for (const [jsKey, dbCol] of Object.entries(allowedFields)) {
      if (data[jsKey] !== undefined) {
        fields.push(`${dbCol} = $${idx}`);
        values.push(data[jsKey]);
        idx++;
      }
    }

    if (fields.length === 0) return product;

    values.push(productId);
    return queryOne(
      `UPDATE products SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
      values
    );
  }

  // ─── Product Versions (AI-generated listing variants) ─────────────

  static async createProductVersion(productId, userId, data) {
    const product = await queryOne(
      `SELECT id, user_id FROM products WHERE id = $1`,
      [productId]
    );
    if (!product) throw new NotFoundError("Product");
    if (product.user_id !== userId) throw new ForbiddenError("Not your product");

    return transaction(async (client) => {
      // Get next version number
      const { max_ver } = await client
        .query(
          `SELECT COALESCE(MAX(version_num), 0) AS max_ver FROM product_versions WHERE product_id = $1`,
          [productId]
        )
        .then((r) => r.rows[0]);

      // Unset previous current version
      if (data.isCurrent) {
        await client.query(
          `UPDATE product_versions SET is_current = false WHERE product_id = $1 AND is_current = true`,
          [productId]
        );
      }

      const result = await client.query(
        `INSERT INTO product_versions (
          product_id, version_num, title, description, bullets,
          cta, hashtags, tone, generated_by, is_current, metadata
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING *`,
        [
          productId,
          max_ver + 1,
          data.title,
          data.description || null,
          data.bullets || [],
          data.cta || null,
          data.hashtags || [],
          data.tone || null,
          data.generatedBy || "ai",
          data.isCurrent !== false,
          data.metadata || {},
        ]
      );
      return result.rows[0];
    });
  }

  static async listProductVersions(productId) {
    return queryAll(
      `SELECT * FROM product_versions WHERE product_id = $1 ORDER BY version_num DESC`,
      [productId]
    );
  }

  static async getCurrentVersion(productId) {
    return queryOne(
      `SELECT * FROM product_versions WHERE product_id = $1 AND is_current = true`,
      [productId]
    );
  }

  // ─── Product Assets ───────────────────────────────────────────────

  static async createAsset(productId, userId, data) {
    return queryOne(
      `INSERT INTO product_assets (
        product_id, user_id, asset_type, file_url, file_name,
        file_size, mime_type, width, height, is_generated,
        generation_prompt, sort_order, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *`,
      [
        productId,
        userId,
        data.assetType || "image",
        data.fileUrl,
        data.fileName || null,
        data.fileSize || null,
        data.mimeType || null,
        data.width || null,
        data.height || null,
        data.isGenerated || false,
        data.generationPrompt || null,
        data.sortOrder || 0,
        data.metadata || {},
      ]
    );
  }

  static async listAssets(productId) {
    return queryAll(
      `SELECT * FROM product_assets WHERE product_id = $1 ORDER BY sort_order ASC, created_at ASC`,
      [productId]
    );
  }

  static async deleteAsset(assetId, userId) {
    const asset = await queryOne(
      `SELECT id, user_id FROM product_assets WHERE id = $1`,
      [assetId]
    );
    if (!asset) throw new NotFoundError("Asset");
    if (asset.user_id !== userId) throw new ForbiddenError("Not your asset");

    await queryOne(`DELETE FROM product_assets WHERE id = $1`, [assetId]);
  }

  // ─── Listing Outputs (channel-specific copy) ─────────────────────

  static async createListingOutput(productId, data) {
    return queryOne(
      `INSERT INTO listing_outputs (
        product_id, product_version_id, channel, title, body,
        cta, hashtags, media_urls, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`,
      [
        productId,
        data.productVersionId || null,
        data.channel,
        data.title || null,
        data.body || null,
        data.cta || null,
        data.hashtags || [],
        data.mediaUrls || [],
        data.metadata || {},
      ]
    );
  }

  static async listListingOutputs(productId) {
    return queryAll(
      `SELECT * FROM listing_outputs WHERE product_id = $1 ORDER BY channel ASC`,
      [productId]
    );
  }

  static async updateListingOutput(outputId, data) {
    const fields = [];
    const values = [];
    let idx = 1;

    for (const [key, col] of Object.entries({
      title: "title",
      body: "body",
      cta: "cta",
      hashtags: "hashtags",
      mediaUrls: "media_urls",
      metadata: "metadata",
    })) {
      if (data[key] !== undefined) {
        fields.push(`${col} = $${idx}`);
        values.push(data[key]);
        idx++;
      }
    }

    if (fields.length === 0) return null;

    values.push(outputId);
    return queryOne(
      `UPDATE listing_outputs SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
      values
    );
  }

  // ─── Approval Requests ────────────────────────────────────────────

  static async createApprovalRequest(userId, data) {
    return queryOne(
      `INSERT INTO approval_requests (
        user_id, product_id, product_version_id, listing_output_id,
        request_type, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *`,
      [
        userId,
        data.productId,
        data.productVersionId || null,
        data.listingOutputId || null,
        data.requestType,
        data.metadata || {},
      ]
    );
  }

  static async listApprovalRequests(userId, { status = null, limit = 25, offset = 0 } = {}) {
    const conditions = ["ar.user_id = $1"];
    const values = [userId];
    let idx = 2;

    if (status) {
      conditions.push(`ar.status = $${idx}`);
      values.push(status);
      idx++;
    }

    values.push(limit, offset);
    return queryAll(
      `SELECT ar.*,
              p.name AS product_name
       FROM approval_requests ar
       JOIN products p ON ar.product_id = p.id
       WHERE ${conditions.join(" AND ")}
       ORDER BY ar.submitted_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    );
  }

  static async reviewApproval(approvalId, userId, decision, notes = null) {
    const approval = await queryOne(
      `SELECT id, user_id, status FROM approval_requests WHERE id = $1`,
      [approvalId]
    );
    if (!approval) throw new NotFoundError("Approval request");
    if (approval.user_id !== userId) throw new ForbiddenError("Not your approval");
    if (approval.status !== "pending") {
      throw new BadRequestError(`Approval already ${approval.status}`);
    }

    if (!["approved", "rejected"].includes(decision)) {
      throw new BadRequestError("Decision must be 'approved' or 'rejected'");
    }

    return queryOne(
      `UPDATE approval_requests
       SET status = $1, reviewer_notes = $2, reviewed_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [decision, notes, approvalId]
    );
  }

  // ─── Promotion Rules ─────────────────────────────────────────────

  static async createPromotionRule(userId, data) {
    return queryOne(
      `INSERT INTO promotion_rules (
        user_id, product_id, rule_name, rule_type, schedule_cron,
        delay_hours, template, channels, max_runs, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *`,
      [
        userId,
        data.productId,
        data.ruleName,
        data.ruleType,
        data.scheduleCron || null,
        data.delayHours || null,
        data.template || null,
        data.channels || [],
        data.maxRuns || null,
        data.metadata || {},
      ]
    );
  }

  static async listPromotionRules(userId, productId = null) {
    const conditions = ["user_id = $1"];
    const values = [userId];
    let idx = 2;

    if (productId) {
      conditions.push(`product_id = $${idx}`);
      values.push(productId);
    }

    return queryAll(
      `SELECT * FROM promotion_rules
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC`,
      values
    );
  }

  static async togglePromotionRule(ruleId, userId, isActive) {
    const rule = await queryOne(
      `SELECT id, user_id FROM promotion_rules WHERE id = $1`,
      [ruleId]
    );
    if (!rule) throw new NotFoundError("Promotion rule");
    if (rule.user_id !== userId) throw new ForbiddenError("Not your rule");

    return queryOne(
      `UPDATE promotion_rules SET is_active = $1 WHERE id = $2 RETURNING *`,
      [isActive, ruleId]
    );
  }

  // ─── Campaign Runs (audit log) ───────────────────────────────────

  static async createCampaignRun(userId, data) {
    return queryOne(
      `INSERT INTO campaign_runs (
        user_id, promotion_rule_id, product_id, publishing_job_id,
        run_type, status, summary
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *`,
      [
        userId,
        data.promotionRuleId || null,
        data.productId || null,
        data.publishingJobId || null,
        data.runType || "manual",
        data.status || "running",
        data.summary || {},
      ]
    );
  }

  static async listCampaignRuns(userId, { limit = 25, offset = 0 } = {}) {
    return queryAll(
      `SELECT cr.*,
              p.name AS product_name,
              pr.rule_name AS promotion_rule_name
       FROM campaign_runs cr
       LEFT JOIN products p ON cr.product_id = p.id
       LEFT JOIN promotion_rules pr ON cr.promotion_rule_id = pr.id
       WHERE cr.user_id = $1
       ORDER BY cr.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
  }

  static async completeCampaignRun(runId, status, summary = {}) {
    return queryOne(
      `UPDATE campaign_runs
       SET status = $1, completed_at = NOW(), summary = $2
       WHERE id = $3
       RETURNING *`,
      [status, summary, runId]
    );
  }

  static async getCampaignRun(runId, userId) {
    const run = await queryOne(
      `SELECT cr.*,
              p.name AS product_name,
              pr.rule_name AS promotion_rule_name
       FROM campaign_runs cr
       LEFT JOIN products p ON cr.product_id = p.id
       LEFT JOIN promotion_rules pr ON cr.promotion_rule_id = pr.id
       WHERE cr.id = $1 AND cr.user_id = $2`,
      [runId, userId]
    );
    if (!run) throw new NotFoundError("Campaign run");
    return run;
  }

  static async updateCampaignRun(runId, userId, { status, summary }) {
    const run = await queryOne(
      `SELECT id, user_id FROM campaign_runs WHERE id = $1`,
      [runId]
    );
    if (!run) throw new NotFoundError("Campaign run");
    if (run.user_id !== userId) throw new ForbiddenError("Not your campaign run");

    const sets = [];
    const values = [];
    let idx = 1;

    if (status) {
      sets.push(`status = $${idx}`);
      values.push(status);
      idx++;
      if (status === "completed" || status === "failed") {
        sets.push(`completed_at = NOW()`);
      }
    }
    if (summary !== undefined) {
      sets.push(`summary = $${idx}`);
      values.push(JSON.stringify(summary));
      idx++;
    }

    if (sets.length === 0) return this.getCampaignRun(runId, userId);

    values.push(runId);
    return queryOne(
      `UPDATE campaign_runs SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
      values
    );
  }

  // ─── Connected Social Accounts ────────────────────────────────────

  static async listSocialAccounts(userId) {
    return queryAll(
      `SELECT id, provider, provider_account_id, platform, platform_account_id,
              account_name, account_url, scopes, is_active, last_used_at,
              token_expires_at, metadata, created_at
       FROM connected_social_accounts
       WHERE user_id = $1 AND is_active = true AND platform_account_id IS NOT NULL
       ORDER BY platform ASC, created_at DESC`,
      [userId]
    );
  }

  /**
   * Deactivate (remove) any existing social accounts for the same user+platform
   * before connecting a new one, so only one account per platform exists.
   * Also removes associated publishing_targets.
   */
  static async _deactivateOldAccountsForPlatform(userId, platform, keepAccountId = null) {
    // Find old accounts for this platform
    const old = await queryAll(
      `SELECT id, provider, provider_account_id FROM connected_social_accounts
       WHERE user_id = $1 AND LOWER(platform) = LOWER($2) AND is_active = true
       ${keepAccountId ? 'AND id != $3' : ''}
       `,
      keepAccountId ? [userId, platform, keepAccountId] : [userId, platform]
    );
    for (const acct of old) {
      console.log(`[seller] Deactivating old ${platform} account id=${acct.id} provider_account_id=${acct.provider_account_id} for user ${userId}`);
      // Remove associated publishing targets first
      await queryAll(
        `DELETE FROM publishing_targets WHERE social_account_id = $1 AND user_id = $2`,
        [acct.id, userId]
      );
      // If Zernio-managed, remove from Zernio
      if (acct.provider === 'zernio' && acct.provider_account_id) {
        try {
          const { getZernioService } = require('./ZernioService');
          const zernio = getZernioService();
          await zernio.deleteAccount(acct.provider_account_id);
        } catch (err) {
          console.warn(`[seller] Failed to delete old Zernio account ${acct.provider_account_id}:`, err.message);
        }
      }
      // Delete the account row
      await queryOne(`DELETE FROM connected_social_accounts WHERE id = $1`, [acct.id]);
    }
    if (old.length > 0) {
      console.log(`[seller] Deactivated ${old.length} old ${platform} account(s) for user ${userId}`);
    }
  }

  static async connectSocialAccount(userId, data) {
    // Remove any existing accounts for this platform before connecting
    await this._deactivateOldAccountsForPlatform(userId, data.platform);
    return queryOne(
      `INSERT INTO connected_social_accounts (
        user_id, provider, provider_account_id, platform,
        platform_account_id, account_name, account_url,
        access_token_enc, refresh_token_enc, token_expires_at,
        scopes, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (user_id, provider, platform, platform_account_id)
      DO UPDATE SET
        account_name = EXCLUDED.account_name,
        account_url = EXCLUDED.account_url,
        access_token_enc = EXCLUDED.access_token_enc,
        refresh_token_enc = EXCLUDED.refresh_token_enc,
        token_expires_at = EXCLUDED.token_expires_at,
        scopes = EXCLUDED.scopes,
        metadata = EXCLUDED.metadata,
        is_active = true,
        updated_at = NOW()
      RETURNING *`,
      [
        userId,
        data.provider,
        data.providerAccountId || null,
        data.platform,
        data.platformAccountId || null,
        data.accountName || null,
        data.accountUrl || null,
        data.accessTokenEnc || null,
        data.refreshTokenEnc || null,
        data.tokenExpiresAt || null,
        data.scopes || [],
        data.metadata || {},
      ]
    );
  }

  static async disconnectSocialAccount(accountId, userId) {
    const account = await queryOne(
      `SELECT id, user_id, provider, provider_account_id, metadata FROM connected_social_accounts WHERE id = $1`,
      [accountId]
    );
    if (!account) throw new NotFoundError("Social account");
    if (account.user_id !== userId) throw new ForbiddenError("Not your account");

    // If this is a Zernio-managed account, remove it from Zernio so the
    // profile slot is freed and the user can reconnect later.
    if (account.provider === "zernio" && account.provider_account_id) {
      try {
        const { getZernioService } = require("./ZernioService");
        const zernio = getZernioService();
        await zernio.deleteAccount(account.provider_account_id);
        console.log(`[seller] Deleted Zernio account ${account.provider_account_id} for user ${userId}`);
      } catch (err) {
        // Log but don't block — the local record should still be removed
        console.warn(`[seller] Failed to delete Zernio account ${account.provider_account_id}:`, err.message);
      }
    }

    return queryOne(
      `DELETE FROM connected_social_accounts WHERE id = $1 RETURNING id`,
      [accountId]
    );
  }

  // ─── Zernio API Key (system-managed) ─────────────────────────────────

  /**
   * The Zernio API key is now a system-level env var (ZERNIO_API_KEY).
   * These stubs are kept for backwards compatibility with existing routes.
   */
  static async getZernioApiKeyStatus(_userId) {
    const config = require("../config");
    const hasKey = !!config.zernio.apiKey;
    return { hasKey, maskedKey: hasKey ? "System-managed" : null };
  }

  // ─── Zernio OAuth Flow ────────────────────────────────────────────

  /**
   * Initiate a Zernio OAuth connect flow for a platform.
   * Stores the pending state in the DB so we can match the callback.
   */
  static async initiateZernioConnect(userId, platform, zernioProfileId, callbackUrl = null) {
    const { getZernioService } = require("./ZernioService");
    const zernio = getZernioService();

    const { authUrl, state } = await zernio.getConnectUrl(platform, zernioProfileId, callbackUrl);

    // No pending row stored — Zernio holds the OAuth state. The callback will
    // upsert the real account once the user completes the OAuth flow.

    return { authUrl, state };
  }

  /**
   * Complete the Zernio OAuth callback — exchange code for account.
   */
  static async completeZernioConnect(userId, platform, { code, state, zernioProfileId }) {
    const { getZernioService } = require("./ZernioService");
    const zernio = getZernioService();

    const result = await zernio.handleOAuthCallback(platform, { code, state, profileId: zernioProfileId });

    // Remove any existing accounts for this platform before connecting the new one
    await this._deactivateOldAccountsForPlatform(userId, platform);

    // Upsert the connected account with Zernio data
    const account = await queryOne(
      `INSERT INTO connected_social_accounts (
        user_id, provider, provider_account_id, platform,
        platform_account_id, account_name, account_url,
        is_active, metadata
      ) VALUES ($1, 'zernio', $2, $3, $4, $5, $6, true, $7)
      ON CONFLICT (user_id, provider, platform, platform_account_id)
      DO UPDATE SET
        provider_account_id = EXCLUDED.provider_account_id,
        account_name = EXCLUDED.account_name,
        account_url = EXCLUDED.account_url,
        is_active = true,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *`,
      [
        userId,
        result.accountId,
        platform,
        result.accountId,
        result.displayName || result.username || platform,
        result.profileUrl || null,
        { zernioProfileId, username: result.username, displayName: result.displayName },
      ]
    );

    // Auto-create a publishing target for this account
    await queryOne(
      `INSERT INTO publishing_targets (
        user_id, social_account_id, target_type, target_label, is_default
      ) VALUES ($1, $2, $3, $4, false)
      ON CONFLICT DO NOTHING`,
      [userId, account.id, platform, `${result.displayName || result.username} (${platform})`]
    );

    return account;
  }

  /**
   * Get the user's Zernio profile ID, creating one if needed.
   */
  static async getOrCreateZernioProfile(userId) {
    // Check if user already has a Zernio profile ID stored
    const sp = await queryOne(
      `SELECT metadata FROM seller_profiles WHERE user_id = $1`,
      [userId]
    );

    const existingProfileId = sp?.metadata?.zernioProfileId;
    if (existingProfileId) return existingProfileId;

    const { getZernioService } = require("./ZernioService");
    const zernio = getZernioService();

    // Before creating a new profile, check if one already exists on Zernio
    // (e.g. leftover from a previous session or after account deletions).
    // This prevents "Profile limit reached" errors on free plans.
    try {
      const existing = await zernio.listProfiles();
      const profiles = existing?.profiles || existing?.data || existing || [];
      if (Array.isArray(profiles) && profiles.length > 0) {
        const reuse = profiles[0];
        const reuseId = reuse._id || reuse.id;
        if (reuseId) {
          console.log(`[seller] Reusing existing Zernio profile ${reuseId} for user ${userId}`);
          // Store it so we don't look up again next time
          if (sp) {
            await queryOne(
              `UPDATE seller_profiles SET metadata = COALESCE(metadata, '{}'::jsonb) || $1 WHERE user_id = $2`,
              [JSON.stringify({ zernioProfileId: reuseId }), userId]
            );
          }
          return reuseId;
        }
      }
    } catch (listErr) {
      console.warn(`[seller] Failed to list Zernio profiles, will try to create:`, listErr.message);
    }

    // Create a new Zernio profile for this user
    const { profile } = await zernio.createProfile(`mawaDao User ${userId.slice(0, 8)}`);

    // Store the profile ID in seller_profiles metadata
    await queryOne(
      `UPDATE seller_profiles SET metadata = COALESCE(metadata, '{}'::jsonb) || $1 WHERE user_id = $2`,
      [JSON.stringify({ zernioProfileId: profile._id }), userId]
    );

    return profile._id;
  }

  /**
   * Handle an incoming Zernio OAuth callback.
   * Called after the user has authenticated with the social platform.
   * The userId is provided directly (authenticated via JWT in the request).
   * Runs within the rlsStorage context set by requireUserAuth.
   */
  static async handleZernioCallback(userId, platform, accountId, username, connectToken) {
    // Remove any existing accounts for this platform before connecting the new one
    await this._deactivateOldAccountsForPlatform(userId, platform);

    // Upsert the connected account
    const account = await queryOne(
      `INSERT INTO connected_social_accounts (
        user_id, provider, provider_account_id, platform,
        platform_account_id, account_name, is_active, metadata
      ) VALUES ($1, 'zernio', $2, $3, $4, $5, true, $6)
      ON CONFLICT (user_id, provider, platform, platform_account_id)
      DO UPDATE SET
        provider_account_id = EXCLUDED.provider_account_id,
        account_name = EXCLUDED.account_name,
        is_active = true,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *`,
      [
        userId,
        accountId,
        platform,
        accountId,
        username || platform,
        JSON.stringify({ username, connectToken }),
      ]
    );

    // Auto-create a publishing target if not already present
    await queryOne(
      `INSERT INTO publishing_targets (
        user_id, social_account_id, target_type, target_label, is_default
      ) VALUES ($1, $2, $3, $4, false)
      ON CONFLICT DO NOTHING`,
      [userId, account.id, platform, `${username || platform} (${platform})`]
    );

    return { platform, accountId, username, userId };
  }

  // ─── Publishing Targets ───────────────────────────────────────────

  static async listPublishingTargets(userId) {
    return queryAll(
      `SELECT pt.*, csa.platform, csa.account_name, csa.provider
       FROM publishing_targets pt
       LEFT JOIN connected_social_accounts csa ON pt.social_account_id = csa.id
       WHERE pt.user_id = $1 AND pt.is_active = true
       ORDER BY pt.is_default DESC, pt.created_at ASC`,
      [userId]
    );
  }

  static async createPublishingTarget(userId, data) {
    return queryOne(
      `INSERT INTO publishing_targets (
        user_id, social_account_id, target_type, target_label,
        is_default, config
      ) VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *`,
      [
        userId,
        data.socialAccountId || null,
        data.targetType,
        data.targetLabel || null,
        data.isDefault || false,
        data.config || {},
      ]
    );
  }

  // ─── Marketplace browse (public) ──────────────────────────────────

  static async browseMarketplaceProducts({ limit = 25, offset = 0, category = null, search = null } = {}) {
    const conditions = ["p.status = 'active'"];
    const values = [];
    let idx = 1;

    if (category) {
      conditions.push(`sc.slug = $${idx}`);
      values.push(category);
      idx++;
    }

    if (search) {
      conditions.push(`(p.name ILIKE $${idx} OR p.summary ILIKE $${idx} OR p.description ILIKE $${idx})`);
      values.push(`%${search}%`);
      idx++;
    }

    values.push(limit, offset);
    return queryAll(
      `SELECT p.id, p.name, p.summary, p.price, p.pricing_model, p.currency,
              p.tags, p.created_at,
              sp.business_name AS seller_name, sp.logo_url AS seller_logo,
              sc.slug AS category_slug, sc.name AS category_name,
              (SELECT file_url FROM product_assets pa WHERE pa.product_id = p.id AND pa.asset_type = 'thumbnail' ORDER BY sort_order LIMIT 1) AS thumbnail_url
       FROM products p
       LEFT JOIN seller_profiles sp ON p.seller_profile_id = sp.id
       LEFT JOIN seller_categories sc ON p.category_id = sc.id
       WHERE ${conditions.join(" AND ")}
       ORDER BY p.created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    );
  }

  // ── Marketplace Orders ───────────────────────────────────────────

  static async createOrder(sellerUserId, data) {
    // Validate product exists and belongs to the seller
    const product = await queryOne(
      `SELECT id, user_id, price, currency FROM products WHERE id = $1`,
      [data.productId]
    );
    if (!product) throw new NotFoundError("Product");
    if (product.user_id !== sellerUserId) {
      throw new ForbiddenError("Not your product");
    }

    return queryOne(
      `INSERT INTO product_orders (
        product_id, seller_user_id, buyer_user_id, buyer_agent_id,
        amount, currency, payment_link_id, payment_status,
        delivery_status, status, notes, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *`,
      [
        data.productId,
        sellerUserId,
        data.buyerUserId || null,
        data.buyerAgentId || null,
        data.amount || product.price,
        data.currency || product.currency || "USDC",
        data.paymentLinkId || null,
        "pending",
        "pending",
        "created",
        data.notes || null,
        data.metadata || {},
      ]
    );
  }

  static async getOrder(orderId) {
    const order = await queryOne(
      `SELECT mo.*,
              p.name AS product_name,
              p.summary AS product_summary
       FROM product_orders mo
       JOIN products p ON mo.product_id = p.id
       WHERE mo.id = $1`,
      [orderId]
    );
    if (!order) throw new NotFoundError("Order");
    return order;
  }

  static async listOrders(userId, { status = null, productId = null, limit = 25, offset = 0 } = {}) {
    const conditions = ["mo.seller_user_id = $1"];
    const values = [userId];
    let idx = 2;

    if (status) {
      conditions.push(`mo.status = $${idx}`);
      values.push(status);
      idx++;
    }

    if (productId) {
      conditions.push(`mo.product_id = $${idx}`);
      values.push(productId);
      idx++;
    }

    values.push(limit, offset);
    return queryAll(
      `SELECT mo.*,
              p.name AS product_name,
              p.summary AS product_summary
       FROM product_orders mo
       JOIN products p ON mo.product_id = p.id
       WHERE ${conditions.join(" AND ")}
       ORDER BY mo.created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    );
  }

  static async updateOrder(orderId, userId, data) {
    const order = await queryOne(
      `SELECT id, seller_user_id FROM product_orders WHERE id = $1`,
      [orderId]
    );
    if (!order) throw new NotFoundError("Order");
    if (order.seller_user_id !== userId) {
      throw new ForbiddenError("Not your order");
    }

    const fields = [];
    const values = [];
    let idx = 1;

    const allowedFields = {
      status: "status",
      deliveryStatus: "delivery_status",
      deliveryData: "delivery_data",
      notes: "notes",
      metadata: "metadata",
    };

    for (const [jsKey, dbCol] of Object.entries(allowedFields)) {
      if (data[jsKey] !== undefined) {
        fields.push(`${dbCol} = $${idx}`);
        values.push(data[jsKey]);
        idx++;
      }
    }

    // Auto-set timestamps based on status transitions
    if (data.deliveryStatus === "delivered") {
      fields.push(`delivered_at = NOW()`);
    }

    if (fields.length === 0) return order;

    values.push(orderId);
    return queryOne(
      `UPDATE product_orders SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
      values
    );
  }

  static async confirmPayment(orderId, userId, data) {
    const order = await queryOne(
      `SELECT id, seller_user_id, payment_status FROM product_orders WHERE id = $1`,
      [orderId]
    );
    if (!order) throw new NotFoundError("Order");
    if (order.seller_user_id !== userId) {
      throw new ForbiddenError("Not your order");
    }

    return queryOne(
      `UPDATE product_orders
       SET payment_status = 'paid',
           payment_tx_hash = $1,
           payment_chain = $2,
           paid_at = NOW(),
           status = 'confirmed'
       WHERE id = $3
       RETURNING *`,
      [
        data.txHash || null,
        data.chain || null,
        orderId,
      ]
    );
  }

  /**
   * Handle incoming PaySponge payment webhook.
   * Called when a buyer completes a payment via a payment link.
   *
   * Runs WITHOUT user auth (external webhook). FORCE ROW LEVEL SECURITY
   * blocks unauthenticated queries, so we use a service-level RLS policy
   * (mo_service_policy) that allows access when app.service_role = 'webhook'.
   */
  static async handlePaymentWebhook(paymentLinkId, data) {
    const { getPool } = require("../config/database");
    const pool = getPool();
    if (!pool) return null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Activate the service-level RLS policy for this transaction
      await client.query("SELECT set_config('app.service_role', 'webhook', true)");

      const lookup = await client.query(
        "SELECT id, seller_user_id, payment_status FROM product_orders WHERE payment_link_id = $1",
        [paymentLinkId]
      );
      const order = lookup.rows[0];
      if (!order) {
        await client.query("COMMIT");
        return null;
      }

      // Also set the seller user ID for any policies that check it
      await client.query(
        "SELECT set_config('app.current_user_id', $1, true)",
        [order.seller_user_id]
      );

      let result;

      if (data.status === "paid" || data.status === "completed") {
        result = await client.query(
          `UPDATE product_orders
           SET payment_status = 'paid',
               payment_tx_hash = $1,
               payment_chain = $2,
               paid_at = NOW(),
               status = 'confirmed'
           WHERE id = $3
           RETURNING *`,
          [
            data.txHash || data.transactionHash || null,
            data.chain || null,
            order.id,
          ]
        );
      } else if (data.status === "failed" || data.status === "expired") {
        result = await client.query(
          `UPDATE product_orders
           SET payment_status = $1,
               status = CASE WHEN $1 = 'expired' THEN 'cancelled' ELSE status END
           WHERE id = $2
           RETURNING *`,
          [data.status, order.id]
        );
      }

      await client.query("COMMIT");
      return result?.rows[0] || order;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  // ─── User Media (global image library) ───────────────────────────

  static async createMedia(userId, data) {
    return queryOne(
      `INSERT INTO user_media (user_id, file_url, file_name, mime_type, source, generation_prompt, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        userId,
        data.fileUrl,
        data.fileName || null,
        data.mimeType || null,
        data.source || "ai_generated",
        data.generationPrompt || null,
        data.metadata || {},
      ]
    );
  }

  static async listMedia(userId, { limit = 50, offset = 0 } = {}) {
    return queryAll(
      `SELECT * FROM user_media WHERE user_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
  }

  static async listUnlinkedMedia(userId) {
    return queryAll(
      `SELECT * FROM user_media WHERE user_id = $1 AND product_id IS NULL
       ORDER BY created_at DESC`,
      [userId]
    );
  }

  static async linkMediaToProduct(mediaId, userId, productId) {
    const media = await queryOne(
      `SELECT * FROM user_media WHERE id = $1 AND user_id = $2`,
      [mediaId, userId]
    );
    if (!media) throw new NotFoundError("Media");

    // Update user_media to link to product
    await queryOne(
      `UPDATE user_media SET product_id = $1 WHERE id = $2`,
      [productId, mediaId]
    );

    // Also create a product_asset so it's visible on the product
    const existing = await queryOne(
      `SELECT id FROM product_assets WHERE product_id = $1 AND file_url = $2`,
      [productId, media.file_url]
    );
    if (!existing) {
      await queryOne(
        `INSERT INTO product_assets (product_id, user_id, asset_type, file_url, file_name, mime_type, is_generated, generation_prompt, sort_order)
         VALUES ($1, $2, 'image', $3, $4, $5, $6, $7, 0)`,
        [productId, userId, media.file_url, media.file_name, media.mime_type, media.source === 'ai_generated', media.generation_prompt]
      );
    }

    return media;
  }

  static async deleteMedia(mediaId, userId) {
    const media = await queryOne(
      `SELECT id, user_id FROM user_media WHERE id = $1`,
      [mediaId]
    );
    if (!media) throw new NotFoundError("Media");
    if (media.user_id !== userId) throw new ForbiddenError("Not your media");
    await queryOne(`DELETE FROM user_media WHERE id = $1`, [mediaId]);
  }
}

module.exports = SellerService;

