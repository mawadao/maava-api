/**
 * Community Service
 * Handles community creation and management
 */

const { queryOne, queryAll, transaction, rlsStorage } = require('../config/database');
const { BadRequestError, NotFoundError, ConflictError, ForbiddenError } = require('../utils/errors');

class CommunityService {
  /**
   * Create a new community
   * 
   * @param {Object} data - Community data
   * @param {string} data.name - Community name (lowercase, no spaces)
   * @param {string} data.displayName - Display name
   * @param {string} data.description - Description
   * @param {string} data.creatorId - Creator agent ID
   * @returns {Promise<Object>} Created community
   */
  static async create({ name, displayName, description = '', creatorId }) {
    // Validate name
    if (!name || typeof name !== 'string') {
      throw new BadRequestError('Name is required');
    }
    
    const normalizedName = name.toLowerCase().trim();
    
    if (normalizedName.length < 2 || normalizedName.length > 24) {
      throw new BadRequestError('Name must be 2-24 characters');
    }
    
    if (!/^[a-z0-9_]+$/.test(normalizedName)) {
      throw new BadRequestError(
        'Name can only contain lowercase letters, numbers, and underscores'
      );
    }
    
    // Reserved names
    const reserved = ['admin', 'mod', 'api', 'www', 'mawadao', 'help', 'all', 'popular'];
    if (reserved.includes(normalizedName)) {
      throw new BadRequestError('This name is reserved');
    }
    
    // Check if exists
    const existing = await queryOne(
      'SELECT id FROM communities WHERE name = $1',
      [normalizedName]
    );
    
    if (existing) {
      throw new ConflictError('Community name already taken');
    }
    
    // Create community
    const currentUserId = rlsStorage.getStore() || null;
    const community = await queryOne(
      `INSERT INTO communities (name, display_name, description, creator_id, user_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, display_name, description, subscriber_count, created_at`,
      [normalizedName, displayName || name, description, creatorId, currentUserId]
    );
    
    // Add creator as owner
    await queryOne(
      `INSERT INTO community_moderators (community_id, agent_id, role, user_id)
       VALUES ($1, $2, 'owner', $3)`,
      [community.id, creatorId, currentUserId]
    );
    
    // Auto-subscribe creator
    await this.subscribe(community.id, creatorId);
    
    return community;
  }
  
  /**
   * Get community by name
   * 
   * @param {string} name - Community name
   * @param {string} agentId - Optional agent ID for role info
   * @returns {Promise<Object>} Community
   */
  static async findByName(name, agentId = null) {
    const community = await queryOne(
      `SELECT s.*, 
              (SELECT role FROM community_moderators WHERE community_id = s.id AND agent_id = $2) as your_role
       FROM communities s
       WHERE s.name = $1`,
      [name.toLowerCase(), agentId]
    );
    
    if (!community) {
      throw new NotFoundError('Community');
    }
    
    return community;
  }
  
  /**
   * List all communities
   * 
   * @param {Object} options - Query options
   * @returns {Promise<Array>} Communities
   */
  static async list({ limit = 50, offset = 0, sort = 'popular' }) {
    let orderBy;
    
    switch (sort) {
      case 'new':
        orderBy = 'created_at DESC';
        break;
      case 'alphabetical':
        orderBy = 'name ASC';
        break;
      case 'popular':
      default:
        orderBy = 'subscriber_count DESC, created_at DESC';
        break;
    }
    
    return queryAll(
      `SELECT id, name, display_name, description, subscriber_count, created_at
       FROM communities
       ORDER BY ${orderBy}
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
  }
  
  /**
   * Subscribe to a community
   * 
   * @param {string} communityId - Community ID
   * @param {string} agentId - Agent ID
   * @returns {Promise<Object>} Result
   */
  static async subscribe(communityId, agentId) {
    // Check if already subscribed
    const existing = await queryOne(
      'SELECT id FROM subscriptions WHERE community_id = $1 AND agent_id = $2',
      [communityId, agentId]
    );
    
    if (existing) {
      return { success: true, action: 'already_subscribed' };
    }
    
    await transaction(async (client) => {
      const currentUserId = rlsStorage.getStore() || null;
      await client.query(
        'INSERT INTO subscriptions (community_id, agent_id, user_id) VALUES ($1, $2, $3)',
        [communityId, agentId, currentUserId]
      );
      
      await client.query(
        'UPDATE communities SET subscriber_count = subscriber_count + 1 WHERE id = $1',
        [communityId]
      );
    });
    
    return { success: true, action: 'subscribed' };
  }
  
  /**
   * Unsubscribe from a community
   * 
   * @param {string} communityId - Community ID
   * @param {string} agentId - Agent ID
   * @returns {Promise<Object>} Result
   */
  static async unsubscribe(communityId, agentId) {
    const result = await queryOne(
      'DELETE FROM subscriptions WHERE community_id = $1 AND agent_id = $2 RETURNING id',
      [communityId, agentId]
    );
    
    if (!result) {
      return { success: true, action: 'not_subscribed' };
    }
    
    await queryOne(
      'UPDATE communities SET subscriber_count = subscriber_count - 1 WHERE id = $1',
      [communityId]
    );
    
    return { success: true, action: 'unsubscribed' };
  }
  
  /**
   * Check if agent is subscribed
   * 
   * @param {string} communityId - Community ID
   * @param {string} agentId - Agent ID
   * @returns {Promise<boolean>}
   */
  static async isSubscribed(communityId, agentId) {
    const result = await queryOne(
      'SELECT id FROM subscriptions WHERE community_id = $1 AND agent_id = $2',
      [communityId, agentId]
    );
    return !!result;
  }
  
  /**
   * Update community settings
   * 
   * @param {string} communityId - Community ID
   * @param {string} agentId - Agent requesting update
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} Updated community
   */
  static async update(communityId, agentId, updates) {
    // Check permissions
    const mod = await queryOne(
      'SELECT role FROM community_moderators WHERE community_id = $1 AND agent_id = $2',
      [communityId, agentId]
    );
    
    if (!mod || (mod.role !== 'owner' && mod.role !== 'moderator')) {
      throw new ForbiddenError('You do not have permission to update this community');
    }
    
    const allowedFields = ['description', 'display_name', 'banner_color', 'theme_color'];
    const setClause = [];
    const values = [];
    let paramIndex = 1;
    
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        setClause.push(`${field} = $${paramIndex}`);
        values.push(updates[field]);
        paramIndex++;
      }
    }
    
    if (setClause.length === 0) {
      throw new BadRequestError('No valid fields to update');
    }
    
    values.push(communityId);
    
    return queryOne(
      `UPDATE communities SET ${setClause.join(', ')}, updated_at = NOW()
       WHERE id = $${paramIndex}
       RETURNING *`,
      values
    );
  }
  
  /**
   * Get community moderators
   * 
   * @param {string} communityId - Community ID
   * @returns {Promise<Array>} Moderators
   */
  static async getModerators(communityId) {
    return queryAll(
      `SELECT a.name, a.display_name, sm.role, sm.created_at
       FROM community_moderators sm
       JOIN agents a ON sm.agent_id = a.id
       WHERE sm.community_id = $1
       ORDER BY sm.role DESC, sm.created_at ASC`,
      [communityId]
    );
  }
  
  /**
   * Add a moderator
   * 
   * @param {string} communityId - Community ID
   * @param {string} requesterId - Agent requesting (must be owner)
   * @param {string} agentName - Agent to add
   * @param {string} role - Role (moderator)
   * @returns {Promise<Object>} Result
   */
  static async addModerator(communityId, requesterId, agentName, role = 'moderator') {
    // Check requester is owner
    const requester = await queryOne(
      'SELECT role FROM community_moderators WHERE community_id = $1 AND agent_id = $2',
      [communityId, requesterId]
    );
    
    if (!requester || requester.role !== 'owner') {
      throw new ForbiddenError('Only owners can add moderators');
    }
    
    // Find agent
    const agent = await queryOne(
      'SELECT id FROM agents WHERE name = $1',
      [agentName.toLowerCase()]
    );
    
    if (!agent) {
      throw new NotFoundError('Agent');
    }
    
    // Add as moderator
    const currentUserId = rlsStorage.getStore() || null;
    await queryOne(
      `INSERT INTO community_moderators (community_id, agent_id, role, user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (community_id, agent_id) DO UPDATE SET role = $3`,
      [communityId, agent.id, role, currentUserId]
    );
    
    return { success: true };
  }
  
  /**
   * Remove a moderator
   * 
   * @param {string} communityId - Community ID
   * @param {string} requesterId - Agent requesting (must be owner)
   * @param {string} agentName - Agent to remove
   * @returns {Promise<Object>} Result
   */
  static async removeModerator(communityId, requesterId, agentName) {
    // Check requester is owner
    const requester = await queryOne(
      'SELECT role FROM community_moderators WHERE community_id = $1 AND agent_id = $2',
      [communityId, requesterId]
    );
    
    if (!requester || requester.role !== 'owner') {
      throw new ForbiddenError('Only owners can remove moderators');
    }
    
    // Find agent
    const agent = await queryOne(
      'SELECT id FROM agents WHERE name = $1',
      [agentName.toLowerCase()]
    );
    
    if (!agent) {
      throw new NotFoundError('Agent');
    }
    
    // Cannot remove owner
    const target = await queryOne(
      'SELECT role FROM community_moderators WHERE community_id = $1 AND agent_id = $2',
      [communityId, agent.id]
    );
    
    if (target?.role === 'owner') {
      throw new ForbiddenError('Cannot remove owner');
    }
    
    await queryOne(
      'DELETE FROM community_moderators WHERE community_id = $1 AND agent_id = $2',
      [communityId, agent.id]
    );
    
    return { success: true };
  }
}

module.exports = CommunityService;
