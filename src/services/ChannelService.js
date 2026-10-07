/**
 * ChannelService
 * CRUD for agent_channels table — stores channel bot credentials per user.
 */

const { queryOne, queryAll } = require('../config/database');
const { NotFoundError, BadRequestError } = require('../utils/errors');

const ALLOWED_TYPES = ['discord', 'slack', 'telegram', 'teams', 'whatsapp', 'web', 'signal', 'line', 'viber'];

class ChannelService {
  /**
   * List all channel connections for a user.
   */
  static async listForUser(userId) {
    const rows = await queryAll(
      `SELECT id, user_id, agent_id, channel_type, channel_name,
              credentials, metadata, is_active, connected_at, last_error,
              created_at, updated_at
         FROM agent_channels
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [userId]
    );
    return rows.map(ChannelService._format);
  }

  /**
   * Get a single channel connection.
   */
  static async getForUser(userId, channelType) {
    const row = await queryOne(
      `SELECT * FROM agent_channels
        WHERE user_id = $1 AND channel_type = $2`,
      [userId, channelType]
    );
    if (!row) return null;
    return ChannelService._format(row);
  }

  /**
   * Upsert a channel connection (insert or update credentials).
   */
  static async upsert({ userId, agentId, channelType, channelName, credentials, metadata }) {
    if (!ALLOWED_TYPES.includes(channelType)) {
      throw new BadRequestError(`Unsupported channel type: ${channelType}`);
    }
    if (!credentials || typeof credentials !== 'object') {
      throw new BadRequestError('credentials must be an object');
    }

    const row = await queryOne(
      `INSERT INTO agent_channels
         (user_id, agent_id, channel_type, channel_name, credentials, metadata, is_active, connected_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, true, NOW())
       ON CONFLICT (user_id, channel_type)
       DO UPDATE SET
         agent_id     = EXCLUDED.agent_id,
         channel_name = EXCLUDED.channel_name,
         credentials  = EXCLUDED.credentials,
         metadata     = COALESCE(EXCLUDED.metadata, agent_channels.metadata),
         is_active    = true,
         connected_at = NOW(),
         last_error   = NULL,
         updated_at   = NOW()
       RETURNING *`,
      [
        userId,
        agentId || null,
        channelType,
        channelName || null,
        JSON.stringify(credentials),
        JSON.stringify(metadata || {}),
      ]
    );
    return ChannelService._format(row);
  }

  /**
   * Mark a channel as inactive (disconnect).
   */
  static async disconnect(userId, channelType) {
    const row = await queryOne(
      `UPDATE agent_channels
          SET is_active  = false,
              last_error = NULL,
              updated_at = NOW()
        WHERE user_id      = $1
          AND channel_type = $2
        RETURNING *`,
      [userId, channelType]
    );
    if (!row) throw new NotFoundError(`No ${channelType} connection found`);
    return ChannelService._format(row);
  }

  /**
   * Hard-delete a channel connection.
   */
  static async delete(userId, channelType) {
    const row = await queryOne(
      `DELETE FROM agent_channels
        WHERE user_id = $1 AND channel_type = $2
        RETURNING id`,
      [userId, channelType]
    );
    if (!row) throw new NotFoundError(`No ${channelType} connection found`);
    return { deleted: true };
  }

  /**
   * Record an error on a channel.
   */
  static async setError(userId, channelType, errorMessage) {
    await queryOne(
      `UPDATE agent_channels
          SET last_error  = $3,
              is_active   = false,
              updated_at  = NOW()
        WHERE user_id      = $1
          AND channel_type = $2`,
      [userId, channelType, errorMessage]
    );
  }

  // Omit raw credentials from public responses
  static _format(row) {
    if (!row) return null;
    return {
      id:          row.id,
      userId:      row.user_id,
      agentId:     row.agent_id,
      channelType: row.channel_type,
      channelName: row.channel_name,
      // Return sanitised credential keys (no values) so front-end can show "configured"
      credentialKeys: Object.keys(row.credentials || {}),
      metadata:    row.metadata || {},
      isActive:    row.is_active,
      connectedAt: row.connected_at,
      lastError:   row.last_error,
      createdAt:   row.created_at,
      updatedAt:   row.updated_at,
    };
  }

  /**
   * Return credentials for internal use (e.g. to push to gateway).
   * Only called server-side, never exposed to the browser.
   */
  static async getCredentials(userId, channelType) {
    const row = await queryOne(
      `SELECT credentials FROM agent_channels
        WHERE user_id = $1 AND channel_type = $2 AND is_active = true`,
      [userId, channelType]
    );
    return row?.credentials || null;
  }
}

module.exports = ChannelService;
