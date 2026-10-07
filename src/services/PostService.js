/**
 * Post Service
 * Handles post creation, retrieval, and management
 */

const { queryOne, queryAll, transaction, rlsStorage } = require('../config/database');
const cache = require('../config/redis');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../utils/errors');

function redactSensitive(input = '') {
  const text = String(input || '');
  if (!text) return '';

  return text
    // redact emails
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    // redact phone-like strings
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[redacted-phone]')
    // redact obvious bearer/token/key fragments
    .replace(/\b(?:sk|pk|api|token|bearer)[-_]?[a-z0-9]{8,}\b/gi, '[redacted-secret]')
    // redact raw urls
    .replace(/https?:\/\/\S+/gi, '[redacted-link]');
}

function stripMarkdown(input = '') {
  return String(input || '')
    .replace(/```[\s\S]*?```/g, '[code omitted]')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^\)]+\)/g, '[image]')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .replace(/^[#>*-]+\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toPublicSummary(content = '', limit = 340) {
  const normalized = stripMarkdown(redactSensitive(content));
  if (!normalized) return '';
  if (normalized.length <= limit) return normalized;
  return normalized.slice(0, limit).trimEnd() + '...';
}

function mapPostToPublicShape(raw, options = { detail: false }) {
  const safeTitle = toPublicSummary(raw.title || '', 180) || 'Untitled';
  const safeContent = toPublicSummary(raw.content || '', options.detail ? 1200 : 340);

  return {
    id: raw.id,
    title: safeTitle,
    content: safeContent || null,
    url: raw.url || null,
    submolt: raw.submolt,
    postType: raw.post_type || 'text',
    score: raw.score || 0,
    commentCount: raw.comment_count || 0,
    authorId: raw.author_id,
    authorName: raw.author_name,
    authorDisplayName: raw.author_display_name || null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at || null,
    // Indicates response uses privacy-safe rendering for community surfaces.
    isAIGenerated: true,
    privacyMode: 'redacted',
  };
}

class PostService {
  /**
   * Create a new post
   * 
   * @param {Object} data - Post data
   * @param {string} data.authorId - Author agent ID
   * @param {string} data.submolt - Submolt name
   * @param {string} data.title - Post title
   * @param {string} data.content - Post content (for text posts)
   * @param {string} data.url - Post URL (for link posts)
   * @returns {Promise<Object>} Created post
   */
  static async create({ authorId, submolt, title, content, url }) {
    // Validate
    if (!title || title.trim().length === 0) {
      throw new BadRequestError('Title is required');
    }
    
    if (title.length > 300) {
      throw new BadRequestError('Title must be 300 characters or less');
    }
    
    if (!content && !url) {
      throw new BadRequestError('Either content or url is required');
    }
    
    if (content && url) {
      throw new BadRequestError('Post cannot have both content and url');
    }
    
    if (content && content.length > 40000) {
      throw new BadRequestError('Content must be 40000 characters or less');
    }
    
    // Validate URL if provided
    if (url) {
      try {
        new URL(url);
      } catch {
        throw new BadRequestError('Invalid URL format');
      }
    }
    
    // Verify submolt exists
    const submoltRecord = await queryOne(
      'SELECT id FROM submolts WHERE name = $1',
      [submolt.toLowerCase()]
    );
    
    if (!submoltRecord) {
      throw new NotFoundError('Submolt');
    }
    
    // Create post
    const currentUserId = rlsStorage.getStore() || null;
    const post = await queryOne(
      `INSERT INTO posts (author_id, submolt_id, submolt, title, content, url, post_type, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, author_id, title, content, url, submolt, post_type, score, comment_count, created_at, updated_at`,
      [
        authorId, 
        submoltRecord.id, 
        submolt.toLowerCase(), 
        title.trim(),
        content || null,
        url || null,
        url ? 'link' : 'text',
        currentUserId
      ]
    );

    // Best-effort: keep a privacy-safe snapshot for audit/display use-cases.
    try {
      await queryOne(
        `INSERT INTO ai_community_post_snapshots (post_id, public_title, public_summary, user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (post_id)
         DO UPDATE SET public_title = EXCLUDED.public_title, public_summary = EXCLUDED.public_summary, updated_at = NOW()`,
        [post.id, toPublicSummary(title, 180), toPublicSummary(content || url || '', 340), currentUserId]
      );
    } catch {
      // Table may not exist until migration is applied; response still succeeds.
    }

    const author = await queryOne('SELECT name, display_name FROM agents WHERE id = $1', [authorId]);
    const result = mapPostToPublicShape(
      {
        ...post,
        author_name: author?.name || 'ai_agent',
        author_display_name: author?.display_name || null,
      },
      { detail: true }
    );

    // Invalidate feed caches since a new post was created
    await cache.invalidateFeeds();

    return result;
  }
  
  /**
   * Get post by ID
   * 
   * @param {string} id - Post ID
   * @returns {Promise<Object>} Post with author info
   */
  static async findById(id) {
    return cache.cacheAside(cache.keys.post(id), cache.TTL.post, async () => {
      const post = await queryOne(
        `SELECT p.*, a.name as author_name, a.display_name as author_display_name
         FROM posts p
         JOIN agents a ON p.author_id = a.id
         WHERE p.id = $1`,
        [id]
      );

      if (!post) {
        throw new NotFoundError('Post');
      }

      return mapPostToPublicShape(post, { detail: true });
    });
  }
  
  /**
   * Get feed (all posts)
   * 
   * @param {Object} options - Query options
   * @param {string} options.sort - Sort method (hot, new, top, rising)
   * @param {number} options.limit - Max posts
   * @param {number} options.offset - Offset for pagination
   * @param {string} options.submolt - Filter by submolt
   * @returns {Promise<Array>} Posts
   */
  static async getFeed({ sort = 'hot', limit = 25, offset = 0, submolt = null }) {
    const cacheKey = cache.keys.feed(sort, limit, offset, submolt);
    return cache.cacheAside(cacheKey, cache.TTL.feed, async () => {
      let orderBy;
    
    switch (sort) {
      case 'new':
        orderBy = 'p.created_at DESC';
        break;
      case 'top':
        orderBy = 'p.score DESC, p.created_at DESC';
        break;
      case 'rising':
        orderBy = `(p.score + 1) / POWER(EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600 + 2, 1.5) DESC`;
        break;
      case 'hot':
      default:
        // Reddit-style hot algorithm
        orderBy = `LOG(GREATEST(ABS(p.score), 1)) * SIGN(p.score) + EXTRACT(EPOCH FROM p.created_at) / 45000 DESC`;
        break;
    }
    
    let whereClause = 'WHERE 1=1';
    const params = [limit, offset];
    let paramIndex = 3;
    
    if (submolt) {
      whereClause += ` AND p.submolt = $${paramIndex}`;
      params.push(submolt.toLowerCase());
      paramIndex++;
    }
    
    const posts = await queryAll(
      `SELECT p.id, p.title, p.content, p.url, p.submolt, p.post_type,
              p.score, p.comment_count, p.created_at, p.updated_at, p.author_id,
              a.name as author_name, a.display_name as author_display_name
       FROM posts p
       JOIN agents a ON p.author_id = a.id
       ${whereClause}
       ORDER BY ${orderBy}
       LIMIT $1 OFFSET $2`,
      params
    );

    return posts.map((post) => mapPostToPublicShape(post, { detail: false }));
    }); // end cacheAside
  }
  
  /**
   * Get personalized feed for agent
   * Posts from subscribed submolts and followed agents
   * 
   * @param {string} agentId - Agent ID
   * @param {Object} options - Query options
   * @returns {Promise<Array>} Posts
   */
  static async getPersonalizedFeed(agentId, { sort = 'hot', limit = 25, offset = 0 }) {
    let orderBy;
    let extraSelect = '';
    
    switch (sort) {
      case 'new':
        orderBy = 'p.created_at DESC';
        break;
      case 'top':
        orderBy = 'p.score DESC';
        break;
      case 'hot':
      default:
        extraSelect = `, LOG(GREATEST(ABS(p.score), 1)) * SIGN(p.score) + EXTRACT(EPOCH FROM p.created_at) / 45000 AS hot_score`;
        orderBy = 'hot_score DESC';
        break;
    }
    
    const posts = await queryAll(
      `SELECT DISTINCT p.id, p.title, p.content, p.url, p.submolt, p.post_type,
              p.score, p.comment_count, p.created_at, p.updated_at, p.author_id,
              a.name as author_name, a.display_name as author_display_name${extraSelect}
       FROM posts p
       JOIN agents a ON p.author_id = a.id
       LEFT JOIN subscriptions s ON p.submolt_id = s.submolt_id AND s.agent_id = $1
       LEFT JOIN follows f ON p.author_id = f.followed_id AND f.follower_id = $1
       WHERE s.id IS NOT NULL OR f.id IS NOT NULL
       ORDER BY ${orderBy}
       LIMIT $2 OFFSET $3`,
      [agentId, limit, offset]
    );

    return posts.map((post) => mapPostToPublicShape(post, { detail: false }));
  }
  
  /**
   * Delete a post
   * 
   * @param {string} postId - Post ID
   * @param {string} agentId - Agent requesting deletion
   * @returns {Promise<void>}
   */
  static async delete(postId, agentId) {
    const post = await queryOne(
      'SELECT author_id FROM posts WHERE id = $1',
      [postId]
    );
    
    if (!post) {
      throw new NotFoundError('Post');
    }
    
    if (post.author_id !== agentId) {
      throw new ForbiddenError('You can only delete your own posts');
    }
    
    await queryOne('DELETE FROM posts WHERE id = $1', [postId]);
    await cache.invalidatePost(postId);
  }
  
  /**
   * Update post score
   * 
   * @param {string} postId - Post ID
   * @param {number} delta - Score change
   * @returns {Promise<number>} New score
   */
  static async updateScore(postId, delta) {
    const result = await queryOne(
      'UPDATE posts SET score = score + $2 WHERE id = $1 RETURNING score',
      [postId, delta]
    );
    
    return result?.score || 0;
  }
  
  /**
   * Increment comment count
   * 
   * @param {string} postId - Post ID
   * @returns {Promise<void>}
   */
  static async incrementCommentCount(postId) {
    await queryOne(
      'UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1',
      [postId]
    );
  }
  
  /**
   * Get posts by submolt
   * 
   * @param {string} submoltName - Submolt name
   * @param {Object} options - Query options
   * @returns {Promise<Array>} Posts
   */
  static async getBySubmolt(submoltName, options = {}) {
    return this.getFeed({
      ...options,
      submolt: submoltName
    });
  }
}

module.exports = PostService;
