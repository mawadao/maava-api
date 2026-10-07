/**
 * User Service
 * Handles user registration, authentication, and profile management
 */

const bcrypt = require("bcrypt");
const { queryOne, queryAll } = require("../config/database");
const {
  generateApiKey,
  hashToken,
} = require("../utils/auth");
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
  UnauthorizedError,
} = require("../utils/errors");

class UserService {
  /**
   * Register a new user
   *
   * @param {Object} data - Registration data
   * @param {string} data.username - Username
   * @param {string} data.email - Email address
   * @param {string} data.password - Password
   * @param {string} data.displayName - Display name (optional)
   * @returns {Promise<Object>} Registration result with API key
   */
  static async register({ username, email, password, displayName = "" }) {
    // Validate username
    if (!username || typeof username !== "string") {
      throw new BadRequestError("Username is required");
    }

    const normalizedUsername = username.toLowerCase().trim();

    if (normalizedUsername.length < 3 || normalizedUsername.length > 32) {
      throw new BadRequestError("Username must be 3-32 characters");
    }

    if (!/^[a-z0-9_]+$/i.test(normalizedUsername)) {
      throw new BadRequestError(
        "Username can only contain letters, numbers, and underscores"
      );
    }

    // Validate email
    if (!email || typeof email !== "string") {
      throw new BadRequestError("Email is required");
    }

    const normalizedEmail = email.toLowerCase().trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      throw new BadRequestError("Invalid email format");
    }

    // Validate password
    if (!password || typeof password !== "string") {
      throw new BadRequestError("Password is required");
    }

    if (password.length < 6) {
      throw new BadRequestError("Password must be at least 6 characters");
    }

    // Check if username exists
    const existingUsername = await queryOne(
      "SELECT id FROM users WHERE username = $1",
      [normalizedUsername]
    );

    if (existingUsername) {
      throw new ConflictError("Username already taken", "Try a different username");
    }

    // Check if email exists
    const existingEmail = await queryOne(
      "SELECT id FROM users WHERE email = $1",
      [normalizedEmail]
    );

    if (existingEmail) {
      throw new ConflictError("Email already registered", "Use a different email or try logging in");
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Generate credentials
    const apiKey = generateApiKey();
    const apiKeyHash = hashToken(apiKey);

    // Create user
    const user = await queryOne(
      `INSERT INTO users (username, email, display_name, password_hash, api_key_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, email, display_name, created_at`,
      [
        normalizedUsername,
        normalizedEmail,
        displayName || normalizedUsername,
        passwordHash,
        apiKeyHash,
      ]
    );

    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.display_name,
        api_key: apiKey,
      },
      important: "Save your API key! You will not see it again.",
    };
  }

  /**
   * Authenticate user with username/email and password
   *
   * @param {string} identifier - Username or email
   * @param {string} password - Password
   * @returns {Promise<Object|null>} User or null if invalid
   */
  static async authenticate(identifier, password) {
    const normalizedIdentifier = identifier.toLowerCase().trim();

    // Try to find by username or email
    const user = await queryOne(
      `SELECT id, username, email, display_name, password_hash, api_key_hash, is_active, is_verified, created_at, updated_at
       FROM users WHERE username = $1 OR email = $1`,
      [normalizedIdentifier]
    );

    if (!user || !user.password_hash || !user.is_active) {
      return null;
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return null;
    }

    // Update last login
    await queryOne(
      `UPDATE users SET last_login = NOW() WHERE id = $1`,
      [user.id]
    );

    // Remove password_hash from response
    delete user.password_hash;
    return user;
  }

  /**
   * Find user by API key
   *
   * @param {string} apiKey - API key
   * @returns {Promise<Object|null>} User or null
   */
  static async findByApiKey(apiKey) {
    const apiKeyHash = hashToken(apiKey);

    return queryOne(
      `SELECT id, username, email, display_name, is_active, is_verified, created_at, updated_at, last_login
       FROM users WHERE api_key_hash = $1 AND is_active = true`,
      [apiKeyHash]
    );
  }

  /**
   * Find user by ID
   *
   * @param {string} id - User UUID
   * @returns {Promise<Object|null>} User or null
   */
  static async findById(id) {
    return queryOne(
      `SELECT id, username, email, display_name, is_active, is_verified, created_at, updated_at, last_login
       FROM users WHERE id = $1 AND is_active = true`,
      [id]
    );
  }

  /**
   * Find user by username
   *
   * @param {string} username - Username
   * @returns {Promise<Object|null>} User or null
   */
  static async findByUsername(username) {
    const normalizedUsername = username.toLowerCase().trim();

    return queryOne(
      `SELECT id, username, email, display_name, is_active, is_verified, created_at, updated_at, last_login
       FROM users WHERE username = $1`,
      [normalizedUsername]
    );
  }

  /**
   * Update user API key hash
   *
   * @param {string} userId - User ID
   * @param {string} apiKeyHash - Hashed API key
   * @returns {Promise<void>}
   */
  static async updateApiKey(userId, apiKeyHash) {
    await queryOne(
      `UPDATE users SET api_key_hash = $1, updated_at = NOW() WHERE id = $2`,
      [apiKeyHash, userId]
    );
  }

  /**
   * Update user profile
   *
   * @param {string} id - User ID
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} Updated user
   */
  static async update(id, updates) {
    const allowedFields = ["display_name", "avatar_url"];
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

    const user = await queryOne(
      `UPDATE users SET ${setClause.join(", ")} WHERE id = $${paramIndex} RETURNING id, username, email, display_name, avatar_url, created_at, updated_at`,
      values
    );

    if (!user) {
      throw new NotFoundError("User");
    }

    return user;
  }
}

module.exports = UserService;
