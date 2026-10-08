/**
 * Channel Routes
 * /api/v1/channels/*
 *
 * Stores and retrieves channel bot credentials per user.
 * All routes require user authentication (Bearer mawadao_* token).
 */

const { Router } = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireUserAuth } = require('../middleware/auth');
const { validate, t } = require('../middleware/validate');
const { success, created, noContent } = require('../utils/response');
const { BadRequestError } = require('../utils/errors');
const ChannelService = require('../services/ChannelService');

const router = Router();

/**
 * GET /channels
 * List the authenticated user's saved channel connections.
 * Credentials are not returned — only which keys are present.
 */
router.get(
  '/',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const channels = await ChannelService.listForUser(req.user.id);
    success(res, { data: channels });
  })
);

/**
 * GET /channels/:channelType
 * Get a single channel connection (no credentials in response).
 */
router.get(
  '/:channelType',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const channel = await ChannelService.getForUser(req.user.id, req.params.channelType);
    if (!channel) {
      return success(res, { data: null });
    }
    success(res, { data: channel });
  })
);

/**
 * POST /channels
 * Save (upsert) a channel connection.
 * Body: { channelType, credentials, channelName?, agentId?, metadata? }
 *
 * credentials is a map of key→value (e.g. { token: "..." } for Discord,
 * { botToken: "...", appToken: "..." } for Slack).
 */
router.post(
  '/',
  requireUserAuth,
  validate({
    body: {
      channelType: t.string({ required: true, max: 32 }),
      channelName: t.string({ max: 100 }),
      agentId: t.uuid(),
      metadata: t.object({ maxKeys: 20, maxBytes: 4096 }),
    },
  }),
  asyncHandler(async (req, res) => {
    const { channelType, credentials, channelName, agentId, metadata } = req.body;

    if (!channelType || typeof channelType !== 'string') {
      throw new BadRequestError('channelType is required');
    }
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
      throw new BadRequestError('credentials must be an object');
    }
    // Reject empty-string credential values (must be non-empty for save to be meaningful)
    const trimmed = {};
    for (const [k, v] of Object.entries(credentials)) {
      if (typeof v === 'string' && v.trim()) {
        trimmed[k] = v.trim();
      }
    }
    if (Object.keys(trimmed).length === 0) {
      throw new BadRequestError('At least one credential value must be provided');
    }

    const channel = await ChannelService.upsert({
      userId:      req.user.id,
      agentId:     agentId || null,
      channelType: channelType.toLowerCase(),
      channelName: channelName ? String(channelName).trim() : null,
      credentials: trimmed,
      metadata:    metadata || {},
    });

    created(res, { data: channel });
  })
);

/**
 * DELETE /channels/:channelType
 * Disconnect (hard-delete) a channel. The caller should also call
 * the mawa gateway to remove the live config.
 */
router.delete(
  '/:channelType',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    await ChannelService.delete(req.user.id, req.params.channelType);
    noContent(res);
  })
);

/**
 * PATCH /channels/:channelType/disable
 * Soft-disconnect: keep the record but mark is_active = false.
 */
router.patch(
  '/:channelType/disable',
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const channel = await ChannelService.disconnect(req.user.id, req.params.channelType);
    success(res, { data: channel });
  })
);

module.exports = router;
