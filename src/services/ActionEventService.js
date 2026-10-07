/**
 * ActionEventService — record short, user-facing progress events for each
 * action block executed by the AI (CREATE_PRODUCT, PUBLISH_PRODUCT,
 * SCHEDULE_DELIVERY, etc.).
 *
 * Each event is:
 *   - persisted to `agent_action_events` (drives chat sidebar live feed)
 *   - posted as a comment on the linked Mission Control task (drives MC view)
 *
 * Both writes are best-effort: failures are logged but never thrown so they
 * cannot break the action pipeline.
 */

const { query, queryOne } = require("../config/database");
const MCSyncService = require("./MCSyncService");

const STATUS_ICON = {
  success: "✅",
  error: "❌",
  skipped: "⏭️",
  running: "⏳",
};

function shorten(text, max = 200) {
  if (!text) return "";
  const s = String(text).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Build a short human line from an executor result row.
 *
 * @param {object} result - { type, status, name?, productId?, error?, ... }
 */
function describe(result) {
  const kind = result.type || "ACTION";
  const status = result.status || "success";
  const icon = STATUS_ICON[status] || "•";

  if (status === "error") {
    return `${icon} ${kind} failed: ${shorten(result.error || result.message, 140)}`;
  }
  if (status === "skipped") {
    return `${icon} ${kind} skipped${result.reason ? `: ${shorten(result.reason, 140)}` : ""}`;
  }
  switch (kind) {
    case "CREATE_PRODUCT":
      return `${icon} Created product “${shorten(result.name, 60)}”`;
    case "UPDATE_PRODUCT":
      return `${icon} Updated product`;
    case "PUBLISH_PRODUCT":
      return `${icon} Published${result.platform ? ` to ${result.platform}` : ""}`;
    case "DELIVER":
      return `${icon} Delivered${result.platform ? ` via ${result.platform}` : ""}`;
    case "SCHEDULE_DELIVERY":
      return `${icon} Scheduled${result.schedule ? ` (${result.schedule})` : ""}${result.platform ? ` on ${result.platform}` : ""}`;
    case "CREATE_TASK":
      return `${icon} Created task${result.title ? ` “${shorten(result.title, 60)}”` : ""}`;
    case "UPDATE_TASK":
      return `${icon} Updated task`;
    case "SELLER_SQL":
      return `${icon} DB query executed`;
    case "ZERNIO_API":
      return `${icon} Social action (${shorten(result.action, 60)})`;
    default:
      return `${icon} ${kind}`;
  }
}

class ActionEventService {
  /**
   * Record a single action event.
   *
   * @param {object} ctx
   * @param {string} ctx.userId
   * @param {string|null} ctx.conversationId
   * @param {string|null} ctx.agentTaskId
   * @param {object} result - executor result row
   */
  static async record(ctx, result) {
    const message = describe(result);
    const status = result.status || "success";

    // 1. Persist to DB (best-effort)
    try {
      await query(
        `INSERT INTO agent_action_events
          (user_id, conversation_id, agent_task_id, kind, status, message, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          ctx.userId,
          ctx.conversationId || null,
          ctx.agentTaskId || null,
          result.type || "ACTION",
          status,
          message,
          JSON.stringify(result || {}),
        ]
      );
    } catch (err) {
      console.error("[action-event] insert failed:", err.message);
    }

    // 2. Push as MC comment if task is linked (best-effort)
    if (ctx.agentTaskId && MCSyncService.isEnabled()) {
      try {
        const row = await queryOne(
          `SELECT mc_task_id, mc_board_id FROM agent_tasks WHERE id = $1`,
          [ctx.agentTaskId]
        );
        if (row?.mc_task_id && row?.mc_board_id) {
          await MCSyncService.appendTaskComment(
            ctx.userId,
            row.mc_board_id,
            row.mc_task_id,
            message
          );
        }
      } catch (err) {
        console.error("[action-event] MC comment failed:", err.message);
      }
    }
  }

  /**
   * Record many results in parallel.
   */
  static async recordBatch(ctx, results) {
    if (!Array.isArray(results) || results.length === 0) return;
    await Promise.allSettled(results.map((r) => this.record(ctx, r)));
  }

  /**
   * Fetch latest events for a conversation (for chat sidebar live feed).
   */
  static async listForConversation(userId, conversationId, limit = 8) {
    const res = await query(
      `SELECT id, kind, status, message, created_at
         FROM agent_action_events
        WHERE user_id = $1 AND conversation_id = $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [userId, conversationId, Math.min(limit, 50)]
    );
    return res.rows || [];
  }
}

module.exports = ActionEventService;
