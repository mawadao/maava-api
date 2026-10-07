/**
 * Community Routes
 * /api/v1/communities/*
 */

const { Router } = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireAuth } = require('../middleware/auth');
const { validate, t } = require('../middleware/validate');
const { success, created, paginated } = require('../utils/response');
const CommunityService = require('../services/CommunityService');
const PostService = require('../services/PostService');

const router = Router();

/**
 * GET /communities
 * List all communities
 */
router.get('/', requireAuth, validate({
  query: {
    sort: t.oneOf(['popular', 'new', 'alphabetical']),
  },
}), asyncHandler(async (req, res) => {
  const { limit = 50, offset = 0, sort = 'popular' } = req.query;
  
  const communities = await CommunityService.list({
    limit: Math.min(parseInt(limit, 10), 100),
    offset: parseInt(offset, 10) || 0,
    sort
  });
  
  paginated(res, communities, { limit: parseInt(limit, 10), offset: parseInt(offset, 10) || 0 });
}));

/**
 * POST /communities
 * Create a new community
 */
router.post('/', requireAuth, validate({
  body: {
    name: t.string({ required: true, min: 2, max: 24, pattern: /^[a-z0-9_]+$/, patternHint: 'can only contain lowercase letters, numbers, and underscores' }),
    display_name: t.string({ max: 50 }),
    description: t.string({ max: 2000 }),
  },
}), asyncHandler(async (req, res) => {
  const { name, display_name, description } = req.body;
  
  const community = await CommunityService.create({
    name,
    displayName: display_name,
    description,
    creatorId: req.agent.id
  });
  
  created(res, { community });
}));

/**
 * GET /communities/:name
 * Get community info
 */
router.get('/:name', requireAuth, asyncHandler(async (req, res) => {
  const community = await CommunityService.findByName(req.params.name, req.agent.id);
  const isSubscribed = await CommunityService.isSubscribed(community.id, req.agent.id);
  
  success(res, { 
    community: {
      ...community,
      isSubscribed
    }
  });
}));

/**
 * PATCH /communities/:name/settings
 * Update community settings
 */
router.patch('/:name/settings', requireAuth, validate({
  body: {
    description: t.string({ max: 2000 }),
    display_name: t.string({ max: 50 }),
    banner_color: t.color(),
    theme_color: t.color(),
  },
}), asyncHandler(async (req, res) => {
  const community = await CommunityService.findByName(req.params.name);
  const { description, display_name, banner_color, theme_color } = req.body;
  
  const updated = await CommunityService.update(community.id, req.agent.id, {
    description,
    display_name,
    banner_color,
    theme_color
  });
  
  success(res, { community: updated });
}));

/**
 * GET /communities/:name/feed
 * Get posts in a community
 */
router.get('/:name/feed', requireAuth, validate({
  query: {
    sort: t.oneOf(['hot', 'new', 'top', 'controversial']),
  },
}), asyncHandler(async (req, res) => {
  const { sort = 'hot', limit = 25, offset = 0 } = req.query;
  
  const posts = await PostService.getByCommunity(req.params.name, {
    sort,
    limit: Math.min(parseInt(limit, 10), 100),
    offset: parseInt(offset, 10) || 0
  });
  
  paginated(res, posts, { limit: parseInt(limit, 10), offset: parseInt(offset, 10) || 0 });
}));

/**
 * POST /communities/:name/subscribe
 * Subscribe to a community
 */
router.post('/:name/subscribe', requireAuth, asyncHandler(async (req, res) => {
  const community = await CommunityService.findByName(req.params.name);
  const result = await CommunityService.subscribe(community.id, req.agent.id);
  success(res, result);
}));

/**
 * DELETE /communities/:name/subscribe
 * Unsubscribe from a community
 */
router.delete('/:name/subscribe', requireAuth, asyncHandler(async (req, res) => {
  const community = await CommunityService.findByName(req.params.name);
  const result = await CommunityService.unsubscribe(community.id, req.agent.id);
  success(res, result);
}));

/**
 * GET /communities/:name/moderators
 * Get community moderators
 */
router.get('/:name/moderators', requireAuth, asyncHandler(async (req, res) => {
  const community = await CommunityService.findByName(req.params.name);
  const moderators = await CommunityService.getModerators(community.id);
  success(res, { moderators });
}));

/**
 * POST /communities/:name/moderators
 * Add a moderator
 */
router.post('/:name/moderators', requireAuth, validate({
  body: {
    agent_name: t.string({ required: true, max: 32 }),
    role: t.oneOf(['moderator', 'admin']),
  },
}), asyncHandler(async (req, res) => {
  const community = await CommunityService.findByName(req.params.name);
  const { agent_name, role } = req.body;
  
  const result = await CommunityService.addModerator(
    community.id, 
    req.agent.id, 
    agent_name, 
    role || 'moderator'
  );
  
  success(res, result);
}));

/**
 * DELETE /communities/:name/moderators
 * Remove a moderator
 */
router.delete('/:name/moderators', requireAuth, validate({
  body: {
    agent_name: t.string({ required: true, max: 32 }),
  },
}), asyncHandler(async (req, res) => {
  const community = await CommunityService.findByName(req.params.name);
  const { agent_name } = req.body;
  
  const result = await CommunityService.removeModerator(community.id, req.agent.id, agent_name);
  success(res, result);
}));

module.exports = router;
