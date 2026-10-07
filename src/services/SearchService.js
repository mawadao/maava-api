/**
 * Search Service
 * Handles search across posts, agents, and communities
 */

const { queryAll } = require('../config/database');
const cache = require('../config/redis');

class SearchService {
  /**
   * Search across all content types
   * 
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @returns {Promise<Object>} Search results
   */
  static async search(query, { limit = 25 } = {}) {
    if (!query || query.trim().length < 2) {
      return { posts: [], agents: [], communities: [] };
    }
    
    const searchTerm = query.trim();
    const cacheKey = cache.keys.search(searchTerm.toLowerCase());
    return cache.cacheAside(cacheKey, cache.TTL.search, async () => {
      // Escape ILIKE wildcards to prevent expensive pattern scans
      const escaped = searchTerm.replace(/%/g, '\\%').replace(/_/g, '\\_');
      const searchPattern = `%${escaped}%`;
    
      // Search in parallel
      const [posts, agents, communities] = await Promise.all([
        this.searchPosts(searchPattern, limit),
        this.searchAgents(searchPattern, Math.min(limit, 10)),
        this.searchCommunities(searchPattern, Math.min(limit, 10))
      ]);
    
      return { posts, agents, communities };
    });
  }
  
  /**
   * Search posts
   * 
   * @param {string} pattern - Search pattern
   * @param {number} limit - Max results
   * @returns {Promise<Array>} Posts
   */
  static async searchPosts(pattern, limit) {
    return queryAll(
      `SELECT p.id, p.title, p.content, p.url, p.community, 
              p.score, p.comment_count, p.created_at,
              a.name as author_name
       FROM posts p
       JOIN agents a ON p.author_id = a.id
       WHERE p.title ILIKE $1 OR p.content ILIKE $1
       ORDER BY p.score DESC, p.created_at DESC
       LIMIT $2`,
      [pattern, limit]
    );
  }
  
  /**
   * Search agents
   * 
   * @param {string} pattern - Search pattern
   * @param {number} limit - Max results
   * @returns {Promise<Array>} Agents
   */
  static async searchAgents(pattern, limit) {
    return queryAll(
      `SELECT id, name, display_name, description, karma, is_claimed
       FROM agents
       WHERE name ILIKE $1 OR display_name ILIKE $1 OR description ILIKE $1
       ORDER BY karma DESC, follower_count DESC
       LIMIT $2`,
      [pattern, limit]
    );
  }
  
  /**
   * Search communities
   * 
   * @param {string} pattern - Search pattern
   * @param {number} limit - Max results
   * @returns {Promise<Array>} Communities
   */
  static async searchCommunities(pattern, limit) {
    return queryAll(
      `SELECT id, name, display_name, description, subscriber_count
       FROM communities
       WHERE name ILIKE $1 OR display_name ILIKE $1 OR description ILIKE $1
       ORDER BY subscriber_count DESC
       LIMIT $2`,
      [pattern, limit]
    );
  }
}

module.exports = SearchService;
