/**
 * Seller Routes
 * /api/v1/seller/*
 *
 * Seller onboarding, product management, listing generation,
 * approval workflow, social publishing, and recurring promotions.
 */

const { Router } = require("express");
const { asyncHandler } = require("../middleware/errorHandler");
const { requireInternalAuth: requireUserAuth } = require("../middleware/auth");
const { validate, t, requireUUIDParam } = require("../middleware/validate");
const { success, created, paginated, noContent } = require("../utils/response");
const { BadRequestError } = require("../utils/errors");
const SellerService = require("../services/SellerService");
const PublishingService = require("../services/PublishingService");
const WalletService = require("../services/WalletService");
const config = require("../config");

const router = Router();

// ─── Categories (public) ────────────────────────────────────────────

router.get(
  "/categories",
  asyncHandler(async (req, res) => {
    const categories = await SellerService.listCategories();
    success(res, { data: categories });
  })
);

// ─── Seller Profile ─────────────────────────────────────────────────

router.get(
  "/profile",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const profile = await SellerService.getProfileByUserId(req.user.id);
    success(res, { data: profile });
  })
);

router.post(
  "/profile",
  requireUserAuth,
  validate({
    body: {
      categoryId: t.uuid(),
      businessName: t.string({ max: 200 }),
      brandVoice: t.string({ max: 100 }),
      tagline: t.string({ max: 300 }),
      targetAudience: t.string({ max: 500 }),
      defaultCta: t.string({ max: 200 }),
      timezone: t.string({ max: 50 }),
      logoUrl: t.url(),
      websiteUrl: t.url(),
    },
  }),
  asyncHandler(async (req, res) => {
    const profile = await SellerService.createProfile(req.user.id, req.body);
    created(res, { data: profile });
  })
);

router.patch(
  "/profile",
  requireUserAuth,
  validate({
    body: {
      categoryId: t.uuid(),
      businessName: t.string({ max: 200 }),
      brandVoice: t.string({ max: 100 }),
      tagline: t.string({ max: 300 }),
      targetAudience: t.string({ max: 500 }),
      defaultCta: t.string({ max: 200 }),
      approvalRequired: t.oneOf(["true", "false"]),
      timezone: t.string({ max: 50 }),
      logoUrl: t.url(),
      websiteUrl: t.url(),
    },
  }),
  asyncHandler(async (req, res) => {
    // Convert string booleans
    if (req.body.approvalRequired !== undefined) {
      req.body.approvalRequired = req.body.approvalRequired === "true";
    }
    const profile = await SellerService.updateProfile(req.user.id, req.body);
    success(res, { data: profile });
  })
);

router.post(
  "/profile/complete-onboarding",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const profile = await SellerService.completeOnboarding(req.user.id);
    success(res, { data: profile });
  })
);

// ─── Products ───────────────────────────────────────────────────────

router.get(
  "/products",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const { limit, offset, status } = req.query;
    const parsedLimit = Math.min(
      Number.parseInt(limit, 10) || config.pagination.defaultLimit,
      config.pagination.maxLimit
    );
    const parsedOffset = Number.parseInt(offset, 10) || 0;

    const products = await SellerService.listProducts(req.user.id, {
      limit: parsedLimit,
      offset: parsedOffset,
      status: status || null,
    });
    paginated(res, products, { limit: parsedLimit, offset: parsedOffset });
  })
);

router.post(
  "/products",
  requireUserAuth,
  validate({
    body: {
      name: t.string({ required: true, min: 2, max: 200 }),
      summary: t.string({ max: 500 }),
      description: t.string({ max: 10000 }),
      price: t.string({ max: 20 }),
      pricingModel: t.oneOf(["one_time", "subscription", "custom", "free", "contact"]),
      currency: t.string({ max: 3 }),
      targetAudience: t.string({ max: 500 }),
      categoryId: t.uuid(),
      productType: t.oneOf(["digital", "physical", "service", "hybrid"]),
    },
  }),
  asyncHandler(async (req, res) => {
    const product = await SellerService.createProduct(req.user.id, req.body);
    created(res, { data: product });
  })
);

router.get(
  "/products/:id",
  requireUserAuth,
  requireUUIDParam("id"),
  asyncHandler(async (req, res) => {
    const product = await SellerService.getProduct(req.params.id);
    success(res, { data: product });
  })
);

router.patch(
  "/products/:id",
  requireUserAuth,
  requireUUIDParam("id"),
  validate({
    body: {
      name: t.string({ min: 2, max: 200 }),
      summary: t.string({ max: 500 }),
      description: t.string({ max: 10000 }),
      price: t.string({ max: 20 }),
      pricingModel: t.oneOf(["one_time", "subscription", "custom", "free", "contact"]),
      productType: t.oneOf(["digital", "physical", "service", "hybrid"]),
      status: t.oneOf(["draft", "active", "paused", "archived"]),
      categoryId: t.uuid(),
    },
  }),
  asyncHandler(async (req, res) => {
    const product = await SellerService.updateProduct(
      req.params.id,
      req.user.id,
      req.body
    );
    success(res, { data: product });
  })
);

// ─── Product Versions (AI-generated listing variants) ───────────────

router.get(
  "/products/:id/versions",
  requireUserAuth,
  requireUUIDParam("id"),
  asyncHandler(async (req, res) => {
    const versions = await SellerService.listProductVersions(req.params.id);
    success(res, { data: versions });
  })
);

router.post(
  "/products/:id/versions",
  requireUserAuth,
  requireUUIDParam("id"),
  validate({
    body: {
      title: t.string({ required: true, min: 2, max: 300 }),
      description: t.string({ max: 10000 }),
      cta: t.string({ max: 500 }),
      tone: t.string({ max: 50 }),
      generatedBy: t.oneOf(["ai", "manual", "hybrid"]),
    },
  }),
  asyncHandler(async (req, res) => {
    const version = await SellerService.createProductVersion(
      req.params.id,
      req.user.id,
      req.body
    );
    created(res, { data: version });
  })
);

router.get(
  "/products/:id/versions/current",
  requireUserAuth,
  requireUUIDParam("id"),
  asyncHandler(async (req, res) => {
    const version = await SellerService.getCurrentVersion(req.params.id);
    success(res, { data: version });
  })
);

// ─── Product Assets ─────────────────────────────────────────────────

router.get(
  "/products/:id/assets",
  requireUserAuth,
  requireUUIDParam("id"),
  asyncHandler(async (req, res) => {
    const assets = await SellerService.listAssets(req.params.id);
    success(res, { data: assets });
  })
);

router.post(
  "/products/:id/assets",
  requireUserAuth,
  requireUUIDParam("id"),
  validate({
    body: {
      assetType: t.oneOf(["image", "thumbnail", "mockup", "promo_card", "video", "document", "other"]),
      fileUrl: t.url({ required: true }),
      fileName: t.string({ max: 255 }),
      mimeType: t.string({ max: 100 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const asset = await SellerService.createAsset(
      req.params.id,
      req.user.id,
      req.body
    );
    created(res, { data: asset });
  })
);

router.delete(
  "/products/:productId/assets/:assetId",
  requireUserAuth,
  requireUUIDParam("assetId"),
  asyncHandler(async (req, res) => {
    await SellerService.deleteAsset(req.params.assetId, req.user.id);
    noContent(res);
  })
);

// ─── Listing Outputs (channel-specific copy) ────────────────────────

router.get(
  "/products/:id/listings",
  requireUserAuth,
  requireUUIDParam("id"),
  asyncHandler(async (req, res) => {
    const outputs = await SellerService.listListingOutputs(req.params.id);
    success(res, { data: outputs });
  })
);

router.post(
  "/products/:id/listings",
  requireUserAuth,
  requireUUIDParam("id"),
  validate({
    body: {
      channel: t.string({ required: true, max: 50 }),
      title: t.string({ max: 300 }),
      body: t.string({ max: 10000 }),
      cta: t.string({ max: 500 }),
      productVersionId: t.uuid(),
    },
  }),
  asyncHandler(async (req, res) => {
    const output = await SellerService.createListingOutput(
      req.params.id,
      req.body
    );
    created(res, { data: output });
  })
);

router.patch(
  "/listings/:id",
  requireUserAuth,
  requireUUIDParam("id"),
  validate({
    body: {
      title: t.string({ max: 300 }),
      body: t.string({ max: 10000 }),
      cta: t.string({ max: 500 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const output = await SellerService.updateListingOutput(
      req.params.id,
      req.body
    );
    success(res, { data: output });
  })
);

// ─── Approval Requests ──────────────────────────────────────────────

router.get(
  "/approvals",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const { status, limit, offset } = req.query;
    const approvals = await SellerService.listApprovalRequests(req.user.id, {
      status: status || null,
      limit: Math.min(Number.parseInt(limit, 10) || 25, 100),
      offset: Number.parseInt(offset, 10) || 0,
    });
    success(res, { data: approvals });
  })
);

router.post(
  "/approvals",
  requireUserAuth,
  validate({
    body: {
      productId: t.uuid({ required: true }),
      productVersionId: t.uuid(),
      listingOutputId: t.uuid(),
      requestType: t.oneOf(["listing", "publish", "visual", "promotion"], { required: true }),
    },
  }),
  asyncHandler(async (req, res) => {
    const approval = await SellerService.createApprovalRequest(
      req.user.id,
      req.body
    );
    created(res, { data: approval });
  })
);

router.post(
  "/approvals/:id/review",
  requireUserAuth,
  requireUUIDParam("id"),
  validate({
    body: {
      decision: t.oneOf(["approved", "rejected"], { required: true }),
      notes: t.string({ max: 2000 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const approval = await SellerService.reviewApproval(
      req.params.id,
      req.user.id,
      req.body.decision,
      req.body.notes
    );
    success(res, { data: approval });
  })
);

// ─── Connected Social Accounts ──────────────────────────────────────

router.get(
  "/social-accounts",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const accounts = await SellerService.listSocialAccounts(req.user.id);
    success(res, { data: accounts });
  })
);

router.post(
  "/social-accounts",
  requireUserAuth,
  validate({
    body: {
      provider: t.string({ required: true, max: 50 }),
      platform: t.string({ required: true, max: 50 }),
      providerAccountId: t.string({ max: 255 }),
      platformAccountId: t.string({ max: 255 }),
      accountName: t.string({ max: 200 }),
      accountUrl: t.url(),
    },
  }),
  asyncHandler(async (req, res) => {
    const account = await SellerService.connectSocialAccount(
      req.user.id,
      req.body
    );
    created(res, { data: account });
  })
);

router.delete(
  "/social-accounts/:id",
  requireUserAuth,
  requireUUIDParam("id"),
  asyncHandler(async (req, res) => {
    await SellerService.disconnectSocialAccount(req.params.id, req.user.id);
    noContent(res);
  })
);

// ─── Zernio API Key Status (system-managed) ────────────────────────

/**
 * GET /social-accounts/zernio-key
 * Returns status of the system-managed Zernio API key.
 * The key is configured via the ZERNIO_API_KEY environment variable.
 */
router.get(
  "/social-accounts/zernio-key",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const status = await SellerService.getZernioApiKeyStatus(req.user.id);
    success(res, { data: status });
  })
);

// ─── Zernio OAuth Connect Flow ──────────────────────────────────────

const SUPPORTED_PLATFORMS = [
  "twitter", "facebook", "instagram", "linkedin", "tiktok",
  "youtube", "threads", "reddit", "pinterest", "bluesky",
  "googlebusiness", "telegram", "snapchat",
];

/**
 * GET /social-accounts/callback
 * Zernio redirects the user's browser here after the social platform OAuth.
 * The oauth-callback Next.js page calls this with the user's auth cookie
 * forwarded as a Bearer token, so we can authenticate and identify the user.
 */
router.get(
  "/social-accounts/callback",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const {
      connected: platform,
      accountId,
      username,
      connect_token: connectToken,
    } = req.query;

    if (!platform || !accountId) {
      return res.status(400).json({ error: "Invalid callback parameters" });
    }

    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: "Unsupported platform" });
    }

    try {
      await SellerService.handleZernioCallback(
        req.user.id,
        platform,
        accountId,
        username || null,
        connectToken || null
      );
      return res.json({ ok: true, platform });
    } catch (err) {
      console.error("[OAuth callback]", err.message);
      return res.status(err.status || 500).json({ error: err.message || "Connection failed" });
    }
  })
);

/**
 * GET /social-accounts/connect/:platform
 * Initiate OAuth flow — returns the Zernio authUrl to redirect the user to.
 */
router.get(
  "/social-accounts/connect/:platform",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const { platform } = req.params;
    const { callbackUrl } = req.query;
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      throw new BadRequestError(`Unsupported platform: ${platform}`);
    }

    // Ensure the user has a Zernio profile
    const zernioProfileId = await SellerService.getOrCreateZernioProfile(req.user.id);

    const { authUrl, state } = await SellerService.initiateZernioConnect(
      req.user.id,
      platform,
      zernioProfileId,
      callbackUrl || null
    );

    success(res, { data: { authUrl, state, platform } });
  })
);

/**
 * POST /social-accounts/connect/:platform/callback
 * Complete OAuth flow — exchange the code for a connected account.
 */
router.post(
  "/social-accounts/connect/:platform/callback",
  requireUserAuth,
  validate({
    body: {
      code: t.string({ required: true, max: 2000 }),
      state: t.string({ required: true, max: 500 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const { platform } = req.params;
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      throw new BadRequestError(`Unsupported platform: ${platform}`);
    }

    const zernioProfileId = await SellerService.getOrCreateZernioProfile(req.user.id);

    const account = await SellerService.completeZernioConnect(
      req.user.id,
      platform,
      {
        code: req.body.code,
        state: req.body.state,
        zernioProfileId,
      }
    );

    success(res, { data: account });
  })
);

/**
 * GET /social-accounts/connect/:platform/options
 * For platforms requiring selection (Facebook pages, Google Business locations).
 */
router.get(
  "/social-accounts/connect/:platform/options",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const { platform } = req.params;
    const { tempToken } = req.query;

    if (!tempToken) throw new BadRequestError("tempToken is required");

    const zernioProfileId = await SellerService.getOrCreateZernioProfile(req.user.id);
    const { getZernioService } = require("../services/ZernioService");
    const zernio = getZernioService();

    let options;
    if (platform === "facebook") {
      options = await zernio.listFacebookPages(zernioProfileId, tempToken);
    } else if (platform === "googlebusiness") {
      options = await zernio.listGoogleBusinessLocations(zernioProfileId, tempToken);
    } else {
      throw new BadRequestError(`Platform ${platform} does not require selection`);
    }

    success(res, { data: options });
  })
);

/**
 * POST /social-accounts/connect/:platform/select
 * Select a specific page/location/org after OAuth.
 */
router.post(
  "/social-accounts/connect/:platform/select",
  requireUserAuth,
  validate({
    body: {
      selectionId: t.string({ required: true, max: 255 }),
      tempToken: t.string({ required: true, max: 2000 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const { platform } = req.params;
    const { selectionId, tempToken } = req.body;

    const zernioProfileId = await SellerService.getOrCreateZernioProfile(req.user.id);
    const { getZernioService } = require("../services/ZernioService");
    const zernio = getZernioService();

    let result;
    if (platform === "facebook") {
      result = await zernio.selectFacebookPage({
        profileId: zernioProfileId,
        pageId: selectionId,
        tempToken,
      });
    } else if (platform === "googlebusiness") {
      result = await zernio.selectGoogleBusinessLocation({
        profileId: zernioProfileId,
        locationId: selectionId,
        tempToken,
      });
    } else {
      throw new BadRequestError(`Platform ${platform} does not support selection`);
    }

    // Store the selected account
    if (result?.account) {
      await SellerService.completeZernioConnect(
        req.user.id,
        platform,
        {
          code: null,
          state: null,
          zernioProfileId,
        }
      );
    }

    success(res, { data: result });
  })
);

/**
 * GET /social-accounts/zernio-accounts
 * List all Zernio-connected accounts for the user's profile.
 */
router.get(
  "/social-accounts/zernio-accounts",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const zernioProfileId = await SellerService.getOrCreateZernioProfile(req.user.id);
    const { getZernioService } = require("../services/ZernioService");
    const zernio = getZernioService();
    const accounts = await zernio.listAccounts(zernioProfileId);
    success(res, { data: accounts });
  })
);

// ─── Publishing Targets ─────────────────────────────────────────────

router.get(
  "/publishing-targets",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const targets = await SellerService.listPublishingTargets(req.user.id);
    success(res, { data: targets });
  })
);

router.post(
  "/publishing-targets",
  requireUserAuth,
  validate({
    body: {
      socialAccountId: t.uuid(),
      targetType: t.string({ required: true, max: 50 }),
      targetLabel: t.string({ max: 200 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const target = await SellerService.createPublishingTarget(
      req.user.id,
      req.body
    );
    created(res, { data: target });
  })
);

// ─── Publishing Jobs ────────────────────────────────────────────────

router.get(
  "/publishing/jobs",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const { status, productId, limit, offset } = req.query;
    const jobs = await PublishingService.listJobs(req.user.id, {
      status: status || null,
      productId: productId || null,
      limit: Math.min(Number.parseInt(limit, 10) || 25, 100),
      offset: Number.parseInt(offset, 10) || 0,
    });
    success(res, { data: jobs });
  })
);

router.get(
  "/publishing/jobs/:id",
  requireUserAuth,
  requireUUIDParam("id"),
  asyncHandler(async (req, res) => {
    const job = await PublishingService.getJob(req.params.id);
    success(res, { data: job });
  })
);

router.get(
  "/publishing/jobs/:id/results",
  requireUserAuth,
  requireUUIDParam("id"),
  asyncHandler(async (req, res) => {
    const results = await PublishingService.getJobResults(req.params.id);
    success(res, { data: results });
  })
);

router.post(
  "/publishing/publish",
  requireUserAuth,
  validate({
    body: {
      productId: t.uuid({ required: true }),
      listingOutputId: t.uuid(),
      publishingTargetId: t.uuid(),
      channel: t.string({ required: true, max: 50 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const job = await PublishingService.createJob({
      userId: req.user.id,
      ...req.body,
    });

    // Dispatch immediately for non-scheduled jobs
    let result = null;
    try {
      result = await PublishingService.dispatchJob(job.id);
    } catch (err) {
      // Job is already created; failure is tracked in publishing_results
    }

    success(res, { data: { job, result } });
  })
);

router.post(
  "/publishing/schedule",
  requireUserAuth,
  validate({
    body: {
      productId: t.uuid({ required: true }),
      listingOutputId: t.uuid(),
      publishingTargetId: t.uuid(),
      channel: t.string({ required: true, max: 50 }),
      scheduledAt: t.string({ required: true }),
    },
  }),
  asyncHandler(async (req, res) => {
    const { scheduledAt, ...rest } = req.body;
    const parsed = new Date(scheduledAt);
    if (Number.isNaN(parsed.getTime()) || parsed <= new Date()) {
      const { BadRequestError } = require("../utils/errors");
      throw new BadRequestError("scheduledAt must be a valid future date");
    }

    const job = await PublishingService.createJob({
      userId: req.user.id,
      ...rest,
      scheduledAt: parsed,
    });

    created(res, { data: job });
  })
);

router.post(
  "/publishing/publish-multi",
  requireUserAuth,
  validate({
    body: {
      productId: t.uuid({ required: true }),
    },
  }),
  asyncHandler(async (req, res) => {
    const { productId, targetIds, scheduledAt } = req.body;
    if (!Array.isArray(targetIds) || targetIds.length === 0) {
      const { BadRequestError } = require("../utils/errors");
      throw new BadRequestError("targetIds must be a non-empty array of UUIDs");
    }

    const results = await PublishingService.publishToMultipleTargets(
      req.user.id,
      productId,
      targetIds,
      { scheduledAt }
    );

    success(res, { data: results });
  })
);

router.post(
  "/publishing/jobs/:id/cancel",
  requireUserAuth,
  requireUUIDParam("id"),
  asyncHandler(async (req, res) => {
    const job = await PublishingService.cancelJob(req.params.id, req.user.id);
    success(res, { data: job });
  })
);

// ─── Promotion Rules ────────────────────────────────────────────────

router.get(
  "/promotions",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const rules = await SellerService.listPromotionRules(
      req.user.id,
      req.query.productId || null
    );
    success(res, { data: rules });
  })
);

router.post(
  "/promotions",
  requireUserAuth,
  validate({
    body: {
      productId: t.uuid({ required: true }),
      ruleName: t.string({ required: true, min: 2, max: 200 }),
      ruleType: t.oneOf(
        ["repost", "reminder", "launch_sequence", "weekend_promo", "still_available", "custom"],
        { required: true }
      ),
      scheduleCron: t.string({ max: 100 }),
      delayHours: t.integer({ min: 1 }),
      template: t.string({ max: 5000 }),
      maxRuns: t.integer({ min: 1 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const rule = await SellerService.createPromotionRule(req.user.id, req.body);
    created(res, { data: rule });
  })
);

router.patch(
  "/promotions/:id/toggle",
  requireUserAuth,
  requireUUIDParam("id"),
  validate({
    body: {
      isActive: t.oneOf(["true", "false"], { required: true }),
    },
  }),
  asyncHandler(async (req, res) => {
    const rule = await SellerService.togglePromotionRule(
      req.params.id,
      req.user.id,
      req.body.isActive === "true"
    );
    success(res, { data: rule });
  })
);

// ─── Campaign Runs ──────────────────────────────────────────────────

router.get(
  "/campaigns",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const { limit, offset } = req.query;
    const runs = await SellerService.listCampaignRuns(req.user.id, {
      limit: Math.min(Number.parseInt(limit, 10) || 25, 100),
      offset: Number.parseInt(offset, 10) || 0,
    });
    success(res, { data: runs });
  })
);

router.post(
  "/campaigns",
  requireUserAuth,
  validate({
    body: {
      runType: t.string({ required: true, max: 50 }),
      status: t.oneOf(["running", "completed", "failed", "skipped"]),
    },
  }),
  asyncHandler(async (req, res) => {
    const run = await SellerService.createCampaignRun(req.user.id, {
      promotionRuleId: req.body.promotionRuleId || null,
      productId: req.body.productId || null,
      publishingJobId: req.body.publishingJobId || null,
      runType: req.body.runType,
      status: req.body.status || "completed",
      summary: req.body.summary || {},
    });
    created(res, { data: run });
  })
);

router.get(
  "/campaigns/:id",
  requireUserAuth,
  requireUUIDParam("id"),
  asyncHandler(async (req, res) => {
    const run = await SellerService.getCampaignRun(req.params.id, req.user.id);
    success(res, { data: run });
  })
);

router.patch(
  "/campaigns/:id",
  requireUserAuth,
  requireUUIDParam("id"),
  asyncHandler(async (req, res) => {
    const { status, summary } = req.body;
    const run = await SellerService.updateCampaignRun(
      req.params.id,
      req.user.id,
      { status, summary }
    );
    success(res, { data: run });
  })
);

// ─── Marketplace Browse (public) ────────────────────────────────────

router.get(
  "/marketplace",
  asyncHandler(async (req, res) => {
    const { limit, offset, category, search } = req.query;
    const parsedLimit = Math.min(
      Number.parseInt(limit, 10) || config.pagination.defaultLimit,
      config.pagination.maxLimit
    );
    const parsedOffset = Number.parseInt(offset, 10) || 0;

    const products = await SellerService.browseMarketplaceProducts({
      limit: parsedLimit,
      offset: parsedOffset,
      category: category || null,
      search: search || null,
    });
    paginated(res, products, { limit: parsedLimit, offset: parsedOffset });
  })
);

// ─── Marketplace Orders ─────────────────────────────────────────────

router.get(
  "/orders",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const { status, productId, limit, offset } = req.query;
    const orders = await SellerService.listOrders(req.user.id, {
      status: status || null,
      productId: productId || null,
      limit: Math.min(Number.parseInt(limit, 10) || 25, 100),
      offset: Number.parseInt(offset, 10) || 0,
    });
    success(res, { data: orders });
  })
);

router.post(
  "/orders",
  requireUserAuth,
  validate({
    body: {
      productId: t.uuid({ required: true }),
      amount: t.string({ required: true, max: 20 }),
      currency: t.string({ max: 10 }),
      paymentLinkId: t.string({ max: 255 }),
      buyerAgentId: t.string({ max: 255 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const order = await SellerService.createOrder(req.user.id, req.body);
    created(res, { data: order });
  })
);

router.get(
  "/orders/:id",
  requireUserAuth,
  requireUUIDParam("id"),
  asyncHandler(async (req, res) => {
    const order = await SellerService.getOrder(req.params.id);
    success(res, { data: order });
  })
);

router.patch(
  "/orders/:id",
  requireUserAuth,
  requireUUIDParam("id"),
  validate({
    body: {
      status: t.oneOf(["created", "confirmed", "completed", "cancelled", "disputed"]),
      deliveryStatus: t.oneOf(["pending", "delivered", "failed"]),
      notes: t.string({ max: 2000 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const order = await SellerService.updateOrder(
      req.params.id,
      req.user.id,
      req.body
    );
    success(res, { data: order });
  })
);

router.post(
  "/orders/:id/confirm-payment",
  requireUserAuth,
  requireUUIDParam("id"),
  validate({
    body: {
      txHash: t.string({ max: 255 }),
      chain: t.string({ max: 50 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const order = await SellerService.confirmPayment(
      req.params.id,
      req.user.id,
      req.body
    );
    success(res, { data: order });
  })
);

// ─── Payment Webhook (PaySponge → mawaDao) ──────────────────────────

router.post(
  "/orders/webhook/payment",
  asyncHandler(async (req, res) => {
    const { paymentLinkId, status, txHash, transactionHash, chain } = req.body;

    if (!paymentLinkId) {
      return res.status(400).json({ error: "Missing paymentLinkId" });
    }

    const result = await SellerService.handlePaymentWebhook(paymentLinkId, {
      status,
      txHash: txHash || transactionHash,
      chain,
    });

    success(res, { data: { received: true, orderId: result?.id || null } });
  })
);

// ─── Wallet Settings ────────────────────────────────────────────────

router.get(
  "/wallet/settings",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const settings = await WalletService.getSettings(req.user.id);
    success(res, { data: settings });
  })
);

router.put(
  "/wallet/settings",
  requireUserAuth,
  validate({
    body: {
      dailyLimit: t.string({ max: 20 }),
      requireApproval: t.oneOf(["true", "false"]),
      autoApproveMax: t.string({ max: 20 }),
      allowedChains: t.string({ max: 500 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const profile = await SellerService.getProfileByUserId(req.user.id);
    if (!profile) {
      throw new BadRequestError("Complete seller onboarding first", "ONBOARDING_REQUIRED");
    }
    if (req.body.requireApproval !== undefined) {
      req.body.requireApproval = req.body.requireApproval === "true";
    }
    if (req.body.allowedChains && typeof req.body.allowedChains === "string") {
      req.body.allowedChains = req.body.allowedChains.split(",").map((c) => c.trim());
    }
    if (req.body.dailyLimit) req.body.dailyLimit = Number(req.body.dailyLimit);
    if (req.body.autoApproveMax) req.body.autoApproveMax = Number(req.body.autoApproveMax);

    const settings = await WalletService.upsertSettings(req.user.id, profile.id, req.body);
    success(res, { data: settings });
  })
);

// ─── Wallet Connect / Disconnect ────────────────────────────────────

router.post(
  "/wallet/connect",
  requireUserAuth,
  validate({
    body: {
      spongeApiKey: t.string({ required: true, min: 10, max: 500 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const profile = await SellerService.getProfileByUserId(req.user.id);
    if (!profile) {
      throw new BadRequestError("Complete seller onboarding first", "ONBOARDING_REQUIRED");
    }
    const settings = await WalletService.connectWallet(
      req.user.id,
      profile.id,
      req.body.spongeApiKey
    );
    success(res, { data: settings });
  })
);

router.post(
  "/wallet/disconnect",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const settings = await WalletService.disconnectWallet(req.user.id);
    success(res, { data: settings });
  })
);

// ─── Wallet Balances ────────────────────────────────────────────────

router.get(
  "/wallet/balances",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const { chain, refresh } = req.query;
    const balances = await WalletService.getBalances(req.user.id, {
      chain: chain || null,
      forceRefresh: refresh === "true",
    });
    success(res, { data: balances });
  })
);

// ─── Wallet Transfers ───────────────────────────────────────────────

router.post(
  "/wallet/transfers",
  requireUserAuth,
  validate({
    body: {
      to: t.string({ required: true, max: 200 }),
      amount: t.string({ required: true, max: 20 }),
      chain: t.string({ max: 20 }),
      currency: t.string({ max: 10 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const result = await WalletService.requestTransfer(req.user.id, {
      ...req.body,
      requestedBy: "user",
    });
    success(res, { data: result });
  })
);

// ─── Wallet Swaps ───────────────────────────────────────────────────

router.post(
  "/wallet/swaps",
  requireUserAuth,
  validate({
    body: {
      from: t.string({ required: true, max: 20 }),
      to: t.string({ required: true, max: 20 }),
      amount: t.string({ required: true, max: 20 }),
      chain: t.string({ max: 20 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const result = await WalletService.requestSwap(req.user.id, {
      ...req.body,
      requestedBy: "user",
    });
    success(res, { data: result });
  })
);

// ─── Wallet Pending Actions ─────────────────────────────────────────

router.get(
  "/wallet/actions",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const { status, actionType, limit, offset } = req.query;
    const actions = await WalletService.listPendingActions(req.user.id, {
      status: status || null,
      actionType: actionType || null,
      limit: Math.min(Number.parseInt(limit, 10) || 25, 100),
      offset: Number.parseInt(offset, 10) || 0,
    });
    success(res, { data: actions });
  })
);

router.post(
  "/wallet/actions/:id/approve",
  requireUserAuth,
  requireUUIDParam("id"),
  asyncHandler(async (req, res) => {
    const result = await WalletService.approveAction(req.user.id, req.params.id);
    success(res, { data: result });
  })
);

router.post(
  "/wallet/actions/:id/reject",
  requireUserAuth,
  validate({
    body: {
      reason: t.string({ max: 500 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const result = await WalletService.rejectAction(
      req.user.id,
      req.params.id,
      req.body.reason
    );
    success(res, { data: result });
  })
);

// ─── Wallet Payment Links ───────────────────────────────────────────

router.post(
  "/wallet/payment-links",
  requireUserAuth,
  validate({
    body: {
      amount: t.string({ required: true, max: 20 }),
      description: t.string({ max: 500 }),
      productId: t.uuid(),
    },
  }),
  asyncHandler(async (req, res) => {
    const result = await WalletService.createPaymentLink(req.user.id, {
      amount: req.body.amount,
      description: req.body.description,
      productId: req.body.productId,
      callbackUrl: `${config.app?.baseUrl || req.protocol + "://" + req.get("host")}/api/v1/seller/orders/webhook/payment`,
    });
    success(res, { data: result });
  })
);

// ─── Wallet Transactions ────────────────────────────────────────────

router.get(
  "/wallet/transactions",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const { chain, limit, offset } = req.query;
    const txns = await WalletService.getTransactionHistory(req.user.id, {
      chain: chain || null,
      limit: Math.min(Number.parseInt(limit, 10) || 25, 100),
      offset: Number.parseInt(offset, 10) || 0,
    });
    success(res, { data: txns });
  })
);

// ─── Wallet Audit Logs ──────────────────────────────────────────────

router.get(
  "/wallet/audit-logs",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const { eventType, limit, offset } = req.query;
    const logs = await WalletService.listAuditLogs(req.user.id, {
      eventType: eventType || null,
      limit: Math.min(Number.parseInt(limit, 10) || 50, 200),
      offset: Number.parseInt(offset, 10) || 0,
    });
    success(res, { data: logs });
  })
);

// ─── Zernio API Proxy (for AI gateway) ─────────────────────────────

/**
 * POST /zernio/proxy
 * Proxies Zernio API calls from the AI gateway.
 * The gateway sends structured action/params and this route
 * dispatches to the right ZernioService method.
 *
 * Allowed actions (whitelist):
 *   list_accounts, create_post, get_post, delete_post, list_profiles
 */
router.post(
  "/zernio/proxy",
  requireUserAuth,
  validate({
    body: {
      action: t.string({ required: true, max: 50 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const { action, params = {} } = req.body;
    const userId = req.user.id;

    const { getZernioService } = require("../services/ZernioService");
    const zernio = getZernioService();

    // Get the user's Zernio profile ID for account-scoped operations
    const zernioProfileId = await SellerService.getOrCreateZernioProfile(userId);

    const ALLOWED_ACTIONS = [
      "list_accounts",
      "create_post",
      "get_post",
      "delete_post",
      "list_profiles",
    ];

    if (!ALLOWED_ACTIONS.includes(action)) {
      throw new BadRequestError(
        `Action "${action}" is not allowed. Allowed: ${ALLOWED_ACTIONS.join(", ")}`
      );
    }

    let result;

    switch (action) {
      case "list_accounts":
        result = await zernio.listAccounts(zernioProfileId);
        break;

      case "list_profiles":
        result = await zernio.listProfiles();
        break;

      case "create_post": {
        // Build the post payload from params
        const {
          platforms,
          content,
          title,
          mediaItems = [],
          scheduledFor,
          publishNow = true,
          hashtags = [],
          tags = [],
        } = params;

        if (!platforms || !Array.isArray(platforms) || platforms.length === 0) {
          throw new BadRequestError("create_post requires 'platforms' array");
        }

        // ── Platform-specific content validation ──
        const PLATFORM_LIMITS = {
          instagram: { maxChars: 2200, requiresMedia: true, label: "Instagram" },
          twitter: { maxChars: 280, requiresMedia: false, label: "Twitter/X" },
          x: { maxChars: 280, requiresMedia: false, label: "Twitter/X" },
          facebook: { maxChars: 63206, requiresMedia: false, label: "Facebook" },
          linkedin: { maxChars: 3000, requiresMedia: false, label: "LinkedIn" },
          tiktok: { maxChars: 2200, requiresMedia: true, label: "TikTok" },
          pinterest: { maxChars: 500, requiresMedia: true, label: "Pinterest" },
          youtube: { maxChars: 5000, requiresMedia: true, label: "YouTube" },
          googlebusiness: { maxChars: 1500, requiresMedia: false, label: "Google Business" },
          threads: { maxChars: 500, requiresMedia: false, label: "Threads" },
        };

        const validationErrors = [];
        const contentLen = (content || "").length;

        for (const p of platforms) {
          const pName = (p.platform || "").toLowerCase();
          const limits = PLATFORM_LIMITS[pName];
          if (!limits) continue;

          if (limits.requiresMedia && (!mediaItems || mediaItems.length === 0)) {
            validationErrors.push(
              `${limits.label} requires at least one image/video in mediaItems`
            );
          }

          // Check custom content or shared content
          const postContent = p.customContent || content || "";
          if (postContent.length > limits.maxChars) {
            validationErrors.push(
              `${limits.label} content is ${postContent.length} chars — max is ${limits.maxChars}`
            );
          }
        }

        if (validationErrors.length > 0) {
          throw new BadRequestError(
            `Content validation failed:\n- ${validationErrors.join("\n- ")}`
          );
        }

        // Convert file:// URLs to public GCS URLs if needed
        const resolvedMediaItems = mediaItems.map((item) => {
          if (item.url && item.url.startsWith("file:///home/node/.openclaw/")) {
            // This is a local gateway path — not accessible from Zernio.
            // Return as-is; Zernio will reject if it can't reach it.
            return item;
          }
          return item;
        });

        result = await zernio.createPost({
          platforms,
          content: content || null,
          title: title || null,
          mediaItems: resolvedMediaItems,
          scheduledFor: scheduledFor || null,
          publishNow: scheduledFor ? false : publishNow,
          hashtags,
          tags,
        });
        break;
      }

      case "get_post":
        if (!params.postId) throw new BadRequestError("get_post requires 'postId'");
        result = await zernio.getPost(params.postId);
        break;

      case "delete_post":
        if (!params.postId) throw new BadRequestError("delete_post requires 'postId'");
        result = await zernio.deletePost(params.postId);
        break;

      default:
        throw new BadRequestError(`Unknown action: ${action}`);
    }

    success(res, { data: result });
  }),
  // Explicit Zernio error handler — ensures providerResponse details are returned
  // even in production (the global error handler hides details in production mode).
  (err, req, res, _next) => {
    if (err.providerResponse || (err.message && err.message.includes("Zernio API error"))) {
      const statusCode = err.status || err.statusCode || 502;
      return res.status(statusCode).json({
        success: false,
        error: err.message,
        providerResponse: err.providerResponse || null,
      });
    }
    // Not a Zernio error — let global handler deal with it
    const statusCode = err.statusCode || err.status || 500;
    return res.status(statusCode).json({
      success: false,
      error: err.message || "Unknown error",
    });
  }
);

// ─── User Media (global image library) ──────────────────────────────

router.get(
  "/media",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const media = await SellerService.listMedia(req.user.id, { limit, offset });
    success(res, { data: media });
  })
);

router.get(
  "/media/unlinked",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const media = await SellerService.listUnlinkedMedia(req.user.id);
    success(res, { data: media });
  })
);

router.post(
  "/media",
  requireUserAuth,
  validate({
    body: {
      fileUrl: t.string({ required: true, max: 2000 }),
      fileName: t.string({ max: 255 }),
      mimeType: t.string({ max: 100 }),
      source: t.oneOf(["ai_generated", "uploaded", "external"]),
      generationPrompt: t.string({ max: 2000 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const media = await SellerService.createMedia(req.user.id, req.body);
    created(res, { data: media });
  })
);

router.post(
  "/media/:mediaId/link/:productId",
  requireUserAuth,
  requireUUIDParam("mediaId"),
  requireUUIDParam("productId"),
  asyncHandler(async (req, res) => {
    const media = await SellerService.linkMediaToProduct(
      req.params.mediaId,
      req.user.id,
      req.params.productId
    );
    success(res, { data: media });
  })
);

router.delete(
  "/media/:mediaId",
  requireUserAuth,
  requireUUIDParam("mediaId"),
  asyncHandler(async (req, res) => {
    await SellerService.deleteMedia(req.params.mediaId, req.user.id);
    noContent(res);
  })
);

module.exports = router;
