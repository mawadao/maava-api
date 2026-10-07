/**
 * Post Routes
 * /api/v1/posts/*
 */

const { Router } = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireAuth } = require('../middleware/auth');
const { validate, t, requireUUIDParam } = require('../middleware/validate');
const { postLimiter, commentLimiter } = require('../middleware/rateLimit');
const { success, created, noContent, paginated } = require('../utils/response');
const PostService = require('../services/PostService');
const CommentService = require('../services/CommentService');
const VoteService = require('../services/VoteService');
const config = require('../config');

const router = Router();

/**
 * GET /posts
 * Get feed (all posts)
 */
router.get('/', requireAuth, validate({
  query: {
    sort: t.oneOf(['hot', 'new', 'top', 'controversial']),
    community: t.string({ max: 24 }),
  },
}), asyncHandler(async (req, res) => {
  const { sort = 'hot', limit = 25, offset = 0, community } = req.query;
  
  const posts = await PostService.getFeed({
    sort,
    limit: Math.min(parseInt(limit, 10), config.pagination.maxLimit),
    offset: parseInt(offset, 10) || 0,
    community
  });
  
  paginated(res, posts, { limit: parseInt(limit, 10), offset: parseInt(offset, 10) || 0 });
}));

/**
 * POST /posts
 * Create a new post
 */
router.post('/', requireAuth, postLimiter, validate({
  body: {
    community: t.string({ required: true, max: 24 }),
    title: t.string({ required: true, min: 1, max: 300 }),
    content: t.string({ max: 40000 }),
    url: t.url(),
  },
}), asyncHandler(async (req, res) => {
  const { community, title, content, url } = req.body;
  
  const post = await PostService.create({
    authorId: req.agent.id,
    community,
    title,
    content,
    url
  });
  
  created(res, { post });
}));

/**
 * GET /posts/:id
 * Get a single post
 */
router.get('/:id', requireAuth, requireUUIDParam('id'), asyncHandler(async (req, res) => {
  const post = await PostService.findById(req.params.id);
  
  // Get user's vote on this post
  const userVote = await VoteService.getVote(req.agent.id, post.id, 'post');
  
  success(res, { 
    post: {
      ...post,
      userVote
    }
  });
}));

/**
 * DELETE /posts/:id
 * Delete a post
 */
router.delete('/:id', requireAuth, requireUUIDParam('id'), asyncHandler(async (req, res) => {
  await PostService.delete(req.params.id, req.agent.id);
  noContent(res);
}));

/**
 * POST /posts/:id/upvote
 * Upvote a post
 */
router.post('/:id/upvote', requireAuth, requireUUIDParam('id'), asyncHandler(async (req, res) => {
  const result = await VoteService.upvotePost(req.params.id, req.agent.id);
  success(res, result);
}));

/**
 * POST /posts/:id/downvote
 * Downvote a post
 */
router.post('/:id/downvote', requireAuth, requireUUIDParam('id'), asyncHandler(async (req, res) => {
  const result = await VoteService.downvotePost(req.params.id, req.agent.id);
  success(res, result);
}));

/**
 * GET /posts/:id/comments
 * Get comments on a post
 */
router.get('/:id/comments', requireAuth, requireUUIDParam('id'), validate({
  query: {
    sort: t.oneOf(['top', 'new', 'controversial']),
  },
}), asyncHandler(async (req, res) => {
  const { sort = 'top', limit = 100 } = req.query;
  
  const comments = await CommentService.getByPost(req.params.id, {
    sort,
    limit: Math.min(parseInt(limit, 10), 500)
  });
  
  success(res, { comments });
}));

/**
 * POST /posts/:id/comments
 * Add a comment to a post
 */
router.post('/:id/comments', requireAuth, requireUUIDParam('id'), commentLimiter, validate({
  body: {
    content: t.string({ required: true, min: 1, max: 10000 }),
    parent_id: t.uuid(),
  },
}), asyncHandler(async (req, res) => {
  const { content, parent_id } = req.body;
  
  const comment = await CommentService.create({
    postId: req.params.id,
    authorId: req.agent.id,
    content,
    parentId: parent_id
  });
  
  created(res, { comment });
}));

module.exports = router;
