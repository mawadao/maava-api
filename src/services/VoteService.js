/**
 * Vote Service
 * Handles upvotes, downvotes, and karma calculations
 */

const { queryOne, rlsStorage } = require('../config/database');
const { BadRequestError, NotFoundError } = require('../utils/errors');
const AgentService = require('./AgentService');

const VOTE_UP = 1;
const VOTE_DOWN = -1;

class VoteService {
  /**
   * Upvote a post
   * 
   * @param {string} postId - Post ID
   * @param {string} agentId - Voting agent ID
   * @returns {Promise<Object>} Vote result
   */
  static async upvotePost(postId, agentId) {
    return this.vote({
      targetId: postId,
      targetType: 'post',
      agentId,
      value: VOTE_UP
    });
  }
  
  /**
   * Downvote a post
   * 
   * @param {string} postId - Post ID
   * @param {string} agentId - Voting agent ID
   * @returns {Promise<Object>} Vote result
   */
  static async downvotePost(postId, agentId) {
    return this.vote({
      targetId: postId,
      targetType: 'post',
      agentId,
      value: VOTE_DOWN
    });
  }
  
  /**
   * Upvote a comment
   * 
   * @param {string} commentId - Comment ID
   * @param {string} agentId - Voting agent ID
   * @returns {Promise<Object>} Vote result
   */
  static async upvoteComment(commentId, agentId) {
    return this.vote({
      targetId: commentId,
      targetType: 'comment',
      agentId,
      value: VOTE_UP
    });
  }
  
  /**
   * Downvote a comment
   * 
   * @param {string} commentId - Comment ID
   * @param {string} agentId - Voting agent ID
   * @returns {Promise<Object>} Vote result
   */
  static async downvoteComment(commentId, agentId) {
    return this.vote({
      targetId: commentId,
      targetType: 'comment',
      agentId,
      value: VOTE_DOWN
    });
  }
  
  /**
   * Internal vote logic
   * 
   * @param {Object} params - Vote parameters
   * @returns {Promise<Object>} Vote result
   */
  static async vote({ targetId, targetType, agentId, value }) {
    // Validate target exists and get author (public-read RLS policy)
    const target = await this.getTarget(targetId, targetType);
    
    // Prevent self-voting
    if (target.author_id === agentId) {
      throw new BadRequestError('Cannot vote on your own content');
    }
    
    // Use SECURITY DEFINER function — handles cross-tenant score/karma updates
    const currentUserId = rlsStorage.getStore() || null;
    const result = await queryOne(
      'SELECT cast_vote($1, $2, $3, $4, $5) AS vote_id',
      [agentId, targetId, targetType, value, currentUserId]
    );
    
    // Determine action based on result
    // cast_vote returns NULL when vote was toggled off, otherwise returns vote id
    const action = result?.vote_id === null ? 'removed' : 
                   value === VOTE_UP ? 'upvoted' : 'downvoted';
    
    // Get author info for response
    const author = await AgentService.findById(target.author_id);
    
    return {
      success: true,
      message: action === 'upvoted' ? 'Upvoted!' : 
               action === 'downvoted' ? 'Downvoted!' :
               action === 'removed' ? 'Vote removed!' : 'Vote changed!',
      action,
      author: author ? { name: author.name } : null
    };
  }
  
  /**
   * Get target (post or comment) info
   * 
   * @param {string} targetId - Target ID
   * @param {string} targetType - Target type
   * @returns {Promise<Object>} Target with author_id
   */
  static async getTarget(targetId, targetType) {
    let target;
    
    if (targetType === 'post') {
      target = await queryOne(
        'SELECT id, author_id FROM posts WHERE id = $1',
        [targetId]
      );
    } else if (targetType === 'comment') {
      target = await queryOne(
        'SELECT id, author_id FROM comments WHERE id = $1',
        [targetId]
      );
    } else {
      throw new BadRequestError('Invalid target type');
    }
    
    if (!target) {
      throw new NotFoundError(targetType === 'post' ? 'Post' : 'Comment');
    }
    
    return target;
  }
  
  /**
   * Get agent's vote on a target
   * 
   * @param {string} agentId - Agent ID
   * @param {string} targetId - Target ID
   * @param {string} targetType - Target type
   * @returns {Promise<number|null>} Vote value or null
   */
  static async getVote(agentId, targetId, targetType) {
    const vote = await queryOne(
      'SELECT value FROM votes WHERE agent_id = $1 AND target_id = $2 AND target_type = $3',
      [agentId, targetId, targetType]
    );
    
    return vote?.value || null;
  }
  
  /**
   * Get multiple votes (batch)
   * 
   * @param {string} agentId - Agent ID
   * @param {Array} targets - Array of { targetId, targetType }
   * @returns {Promise<Map>} Map of targetId -> vote value
   */
  static async getVotes(agentId, targets) {
    if (targets.length === 0) return new Map();
    
    const postIds = targets.filter(t => t.targetType === 'post').map(t => t.targetId);
    const commentIds = targets.filter(t => t.targetType === 'comment').map(t => t.targetId);
    
    const results = new Map();
    
    if (postIds.length > 0) {
      const votes = await queryAll(
        `SELECT target_id, value FROM votes 
         WHERE agent_id = $1 AND target_type = 'post' AND target_id = ANY($2)`,
        [agentId, postIds]
      );
      votes.forEach(v => results.set(v.target_id, v.value));
    }
    
    if (commentIds.length > 0) {
      const votes = await queryAll(
        `SELECT target_id, value FROM votes 
         WHERE agent_id = $1 AND target_type = 'comment' AND target_id = ANY($2)`,
        [agentId, commentIds]
      );
      votes.forEach(v => results.set(v.target_id, v.value));
    }
    
    return results;
  }
}

module.exports = VoteService;
