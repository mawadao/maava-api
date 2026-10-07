/**
 * Marketplace Routes
 * /api/v1/marketplace/*
 */

const { Router } = require("express");
const { asyncHandler } = require("../middleware/errorHandler");
const { requireAuth } = require("../middleware/auth");
const { validate, t, requireUUIDParam } = require("../middleware/validate");
const { success, created, paginated, noContent } = require("../utils/response");
const MarketplaceService = require("../services/MarketplaceService");
const config = require("../config");

const router = Router();

/**
 * GET /marketplace/listings
 * Browse marketplace listings
 */
router.get(
  "/listings",
  asyncHandler(async (req, res) => {
    const { limit, offset, seller } = req.query;

    const parsedLimit = Math.min(
      Number.parseInt(limit, 10) || config.pagination.defaultLimit,
      config.pagination.maxLimit
    );
    const parsedOffset = Number.parseInt(offset, 10) || 0;

    const listings = await MarketplaceService.listListings({
      limit: parsedLimit,
      offset: parsedOffset,
      agentId: seller || null,
      activeOnly: true,
    });

    paginated(res, listings, { limit: parsedLimit, offset: parsedOffset });
  })
);

/**
 * POST /marketplace/listings
 * Create a new listing for the authenticated agent
 */
router.post(
  "/listings",
  requireAuth,
  validate({
    body: {
      title: t.string({ required: true, min: 3, max: 200 }),
      description: t.string({ max: 5000 }),
      priceCredits: t.integer({ required: true, min: 0 }),
      metadata: t.object({ maxKeys: 50, maxBytes: 10240 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const { title, description, priceCredits, metadata } = req.body;

    const listing = await MarketplaceService.createListing({
      agentId: req.agent.id,
      title,
      description,
      priceCredits,
      metadata,
    });

    created(res, { listing });
  })
);

/**
 * GET /marketplace/listings/:id
 * Get a single listing
 */
router.get(
  "/listings/:id",
  requireUUIDParam('id'),
  asyncHandler(async (req, res) => {
    const listing = await MarketplaceService.getListing(req.params.id);
    success(res, { listing });
  })
);

/**
 * DELETE /marketplace/listings/:id
 * Archive a listing (seller only)
 */
router.delete(
  "/listings/:id",
  requireAuth,
  requireUUIDParam('id'),
  asyncHandler(async (req, res) => {
    await MarketplaceService.archiveListing(req.params.id, req.agent.id);
    noContent(res);
  })
);

/**
 * POST /marketplace/listings/:id/buy
 * Buy a listing using credits
 */
router.post(
  "/listings/:id/buy",
  requireAuth,
  requireUUIDParam('id'),
  asyncHandler(async (req, res) => {
    const result = await MarketplaceService.buyListing({
      listingId: req.params.id,
      buyerId: req.agent.id,
    });

    success(res, result);
  })
);

/**
 * GET /marketplace/orders
 * Get orders for the authenticated agent (as buyer/seller/all)
 */
router.get(
  "/orders",
  requireAuth,
  validate({
    query: {
      role: t.oneOf(['buyer', 'seller', 'all']),
    },
  }),
  asyncHandler(async (req, res) => {
    const { role = "buyer" } = req.query;

    const orders = await MarketplaceService.getOrdersForAgent({
      agentId: req.agent.id,
      role,
    });

    success(res, { orders });
  })
);

module.exports = router;
