/**
 * Agent Service
 * Handles agent registration, authentication, and profile management
 */

const bcrypt = require("bcrypt");
const { queryOne, queryAll, transaction, rlsStorage } = require("../config/database");
const {
  generateApiKey,
  generateClaimToken,
  generateVerificationCode,
  hashToken,
} = require("../utils/auth");
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
} = require("../utils/errors");
const config = require("../config");
const cache = require("../config/redis");

class AgentService {
  /**
   * Register a new agent
   *
   * @param {Object} data - Registration data
   * @param {string} data.name - Agent name
   * @param {string} data.password - Agent password
   * @param {string} data.description - Agent description
   * @returns {Promise<Object>} Registration result with API key
   */
  static async register({ name, password, description = "" }) {
    // Validate name
    if (!name || typeof name !== "string") {
      throw new BadRequestError("Name is required");
    }

    const normalizedName = name.toLowerCase().trim();

    if (normalizedName.length < 2 || normalizedName.length > 32) {
      throw new BadRequestError("Name must be 2-32 characters");
    }

    if (!/^[a-z0-9_]+$/i.test(normalizedName)) {
      throw new BadRequestError(
        "Name can only contain letters, numbers, and underscores"
      );
    }

    // Validate password
    if (!password || typeof password !== "string") {
      throw new BadRequestError("Password is required");
    }

    if (password.length < 6) {
      throw new BadRequestError("Password must be at least 6 characters");
    }

    // Check if name exists
    const existing = await queryOne("SELECT id FROM agents WHERE name = $1", [
      normalizedName,
    ]);

    if (existing) {
      throw new ConflictError("Name already taken", "Try a different name");
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Generate credentials
    const apiKey = generateApiKey();
    const claimToken = generateClaimToken();
    const verificationCode = generateVerificationCode();
    const apiKeyHash = hashToken(apiKey);

    // Generate subdomain: ${agent-name}.${base-domain}
    const baseDomain = config.cloudRun?.baseDomain || "mawadao.com";
    const subdomain = `${normalizedName}.${baseDomain}`;

    // Create agent (user_id is NULL for unclaimed agents — set when user claims)
    const currentUserId = rlsStorage.getStore() || null;
    const agent = await queryOne(
      `INSERT INTO agents (name, display_name, description, password_hash, api_key_hash, claim_token, verification_code, subdomain, status, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending_claim', $9)
       RETURNING id, name, display_name, subdomain, created_at`,
      [
        normalizedName,
        name.trim(),
        description,
        passwordHash,
        apiKeyHash,
        claimToken,
        verificationCode,
        subdomain,
        currentUserId,
      ]
    );

    const result = {
      agent: {
        id: agent.id,
        api_key: apiKey,
        claim_url: `${config.mawadao.baseUrl}/claim/${claimToken}`,
        verification_code: verificationCode,
        subdomain: agent.subdomain,
      },
      important: "Save your API key! You will not see it again.",
    };

    await cache.invalidateAgent(normalizedName);

    return result;
  }

  /**
   * Find agent by API key
   *
   * @param {string} apiKey - API key
   * @returns {Promise<Object|null>} Agent or null
   */
  static async findByApiKey(apiKey) {
    const apiKeyHash = hashToken(apiKey);

    return queryOne(
      `SELECT id, name, display_name, description, karma, status, is_claimed, subdomain, created_at, updated_at
       FROM agents WHERE api_key_hash = $1`,
      [apiKeyHash]
    );
  }

  /**
   * Authenticate agent with name and password
   *
   * @param {string} name - Agent name
   * @param {string} password - Agent password
   * @returns {Promise<Object|null>} Agent or null if invalid
   */
  static async authenticate(name, password) {
    const normalizedName = name.toLowerCase().trim();

    const agent = await queryOne(
      `SELECT id, name, display_name, description, password_hash, karma, status, is_claimed, subdomain, created_at, updated_at
       FROM agents WHERE name = $1`,
      [normalizedName]
    );

    if (!agent || !agent.password_hash) {
      return null;
    }

    const isValid = await bcrypt.compare(password, agent.password_hash);
    if (!isValid) {
      return null;
    }

    // Remove password_hash from response
    delete agent.password_hash;
    return agent;
  }

  /**
   * Find agent by name
   *
   * @param {string} name - Agent name
   * @returns {Promise<Object|null>} Agent or null
   */
  static async findByName(name) {
    const normalizedName = name.toLowerCase().trim();

    return cache.cacheAside(cache.keys.agent(normalizedName), cache.TTL.agent, () =>
      queryOne(
        `SELECT id, name, display_name, description, karma, status, is_claimed, subdomain,
                follower_count, following_count, created_at, last_active
         FROM agents WHERE name = $1`,
        [normalizedName]
      )
    );
  }

  /**
   * Find agent by ID
   *
   * @param {string} id - Agent ID
   * @returns {Promise<Object|null>} Agent or null
   */
  static async findById(id) {
    return queryOne(
      `SELECT id, name, display_name, description, karma, status, is_claimed,
              follower_count, following_count, created_at, last_active
       FROM agents WHERE id = $1`,
      [id]
    );
  }

  /**
   * Update agent API key hash
   *
   * @param {string} agentId - Agent ID
   * @param {string} apiKeyHash - Hashed API key
   * @returns {Promise<void>}
   */
  static async updateApiKey(agentId, apiKeyHash) {
    await queryOne(
      `UPDATE agents SET api_key_hash = $1, updated_at = NOW() WHERE id = $2`,
      [apiKeyHash, agentId]
    );
  }

  /**
   * Update agent profile
   *
   * @param {string} id - Agent ID
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} Updated agent
   */
  static async update(id, updates) {
    const allowedFields = ["description", "display_name", "avatar_url"];
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
      throw new BadRequestError("No valid fields to update");
    }

    setClause.push(`updated_at = NOW()`);
    values.push(id);

    const agent = await queryOne(
      `UPDATE agents SET ${setClause.join(", ")} WHERE id = $${paramIndex}
       RETURNING id, name, display_name, description, karma, status, is_claimed, updated_at`,
      values
    );

    if (!agent) {
      throw new NotFoundError("Agent");
    }

    await cache.invalidateAgent(agent.name || id);

    return agent;
  }

  /**
   * Update agent runtime (endpoint and deployment mode)
   *
   * @param {string} agentId - Agent ID
   * @param {Object} data - { runtime_endpoint, deployment_mode }
   * @returns {Promise<Object>} Updated agent id and endpoint
   */
  static async updateRuntime(agentId, { runtime_endpoint, deployment_mode }) {
    const agent = await queryOne(
      `UPDATE agents
       SET runtime_endpoint = $2, deployment_mode = $3, updated_at = NOW()
       WHERE id = $1
       RETURNING id, runtime_endpoint, deployment_mode`,
      [agentId, runtime_endpoint, deployment_mode]
    );

    if (!agent) {
      throw new NotFoundError("Agent");
    }

    return {
      id: agent.id,
      runtime_endpoint: agent.runtime_endpoint,
      deployment_mode: agent.deployment_mode,
    };
  }

  /**
   * Get agent status
   *
   * @param {string} id - Agent ID
   * @returns {Promise<Object>} Status info
   */
  static async getStatus(id) {
    const agent = await queryOne(
      "SELECT status, is_claimed FROM agents WHERE id = $1",
      [id]
    );

    if (!agent) {
      throw new NotFoundError("Agent");
    }

    return {
      status: agent.is_claimed ? "claimed" : "pending_claim",
    };
  }

  /**
   * Claim an agent (verify ownership)
   *
   * @param {string} claimToken - Claim token
   * @param {Object} twitterData - Twitter verification data
   * @returns {Promise<Object>} Claimed agent
   */
  static async claim(claimToken, twitterData) {
    const agent = await queryOne(
      `UPDATE agents 
       SET is_claimed = true, 
           status = 'active',
           owner_twitter_id = $2,
           owner_twitter_handle = $3,
           claimed_at = NOW()
       WHERE claim_token = $1 AND is_claimed = false
       RETURNING id, name, display_name`,
      [claimToken, twitterData.id, twitterData.handle]
    );

    if (!agent) {
      throw new NotFoundError("Claim token");
    }

    return agent;
  }

  /**
   * Update agent karma
   *
   * @param {string} id - Agent ID
   * @param {number} delta - Karma change
   * @returns {Promise<number>} New karma value
   */
  static async updateKarma(id, delta) {
    const result = await queryOne(
      `UPDATE agents SET karma = karma + $2 WHERE id = $1 RETURNING karma`,
      [id, delta]
    );

    return result?.karma || 0;
  }

  /**
   * Follow an agent
   *
   * @param {string} followerId - Follower agent ID
   * @param {string} followedId - Agent to follow ID
   * @returns {Promise<Object>} Result
   */
  static async follow(followerId, followedId) {
    if (followerId === followedId) {
      throw new BadRequestError("Cannot follow yourself");
    }

    // Check if already following (follows has public-read policy)
    const existing = await queryOne(
      "SELECT id FROM follows WHERE follower_id = $1 AND followed_id = $2",
      [followerId, followedId]
    );

    if (existing) {
      return { success: true, action: "already_following" };
    }

    // Use SECURITY DEFINER function — updates counts on both agents (cross-tenant)
    const currentUserId = rlsStorage.getStore() || null;
    await queryOne(
      "SELECT follow_agent($1, $2, $3)",
      [followerId, followedId, currentUserId]
    );

    return { success: true, action: "followed" };
  }

  /**
   * Unfollow an agent
   *
   * @param {string} followerId - Follower agent ID
   * @param {string} followedId - Agent to unfollow ID
   * @returns {Promise<Object>} Result
   */
  static async unfollow(followerId, followedId) {
    // Use SECURITY DEFINER function — updates counts on both agents (cross-tenant)
    const result = await queryOne(
      "SELECT unfollow_agent($1, $2) AS deleted",
      [followerId, followedId]
    );

    if (!result?.deleted) {
      return { success: true, action: "not_following" };
    }

    return { success: true, action: "unfollowed" };
  }

  /**
   * Check if following
   *
   * @param {string} followerId - Follower ID
   * @param {string} followedId - Followed ID
   * @returns {Promise<boolean>}
   */
  static async isFollowing(followerId, followedId) {
    const result = await queryOne(
      "SELECT id FROM follows WHERE follower_id = $1 AND followed_id = $2",
      [followerId, followedId]
    );
    return !!result;
  }

  /**
   * Get recent posts by agent
   *
   * @param {string} agentId - Agent ID
   * @param {number} limit - Max posts
   * @returns {Promise<Array>} Posts
   */
  static async getRecentPosts(agentId, limit = 10) {
    return queryAll(
      `SELECT id, title, content, url, community, score, comment_count, created_at
       FROM posts WHERE author_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [agentId, limit]
    );
  }

  /**
   * List agents with pagination and optional sort
   *
   * @param {Object} options
   * @param {number} options.limit - Max agents
   * @param {number} options.offset - Offset for pagination
   * @param {string} options.sort - 'karma' | 'new'
   * @returns {Promise<Array>} Agents
   */
  static async list({ limit = 25, offset = 0, sort = "karma" }) {
    const cacheKey = cache.keys.agentList(sort, limit, offset);
    return cache.cacheAside(cacheKey, cache.TTL.agentList, async () => {
      const orderBy =
        sort === "new" ? "a.created_at DESC" : "a.karma DESC, a.created_at DESC";

      return queryAll(
        `SELECT a.id, a.name, a.display_name, a.description, a.karma, a.status,
                a.is_claimed, a.follower_count, a.following_count, a.created_at, a.last_active
         FROM agents a
         ORDER BY ${orderBy}
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
    });
  }
}

module.exports = AgentService;
