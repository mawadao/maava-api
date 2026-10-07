/**
 * MCSyncService — Mission Control bidirectional sync bridge.
 *
 * Pushes task create/status changes from agent_tasks → MC board tasks,
 * and provides helpers for MC → agent_tasks status sync.
 *
 * Uses the MC REST API directly (server-to-server, no browser proxy).
 */

const MC_BACKEND_URL = process.env.MISSION_CONTROL_API_URL || "";
const MC_AUTH_TOKEN = process.env.MISSION_CONTROL_AUTH_TOKEN || "";

// ── Status mappings ──────────────────────────────────────────────────────────

const AGENT_TO_MC_STATUS = {
  pending: "inbox",
  running: "in_progress",
  completed: "done",
  failed: "inbox",
  cancelled: "cancelled",
};

const MC_TO_AGENT_STATUS = {
  inbox: "pending",
  in_progress: "running",
  review: "pending",
  done: "completed",
  cancelled: "cancelled",
};

// ── MC Backend HTTP helper ───────────────────────────────────────────────────

async function mcFetch(path, userId, init) {
  if (!MC_BACKEND_URL) return null;

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Forwarded-User-Id": userId,
  };
  if (MC_AUTH_TOKEN) {
    headers["Authorization"] = `Bearer ${MC_AUTH_TOKEN}`;
  }

  try {
    const res = await fetch(`${MC_BACKEND_URL}/api/v1${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers || {}) },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      console.error(`[mc-sync] MC backend ${res.status}: ${text}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error("[mc-sync] MC backend unreachable:", err.message);
    return null;
  }
}

// ── Board helpers ────────────────────────────────────────────────────────────

/**
 * Get or create a default MC board for the user.
 */
async function getDefaultBoard(userId) {
  const boards = await mcFetch("/boards?limit=1", userId);
  if (boards?.items?.length > 0) return boards.items[0];

  // Auto-create
  const created = await mcFetch("/boards", userId, {
    method: "POST",
    body: JSON.stringify({
      name: "Agent Tasks",
      slug: "agent-tasks",
      description: "Auto-created board for agent task management",
      board_type: "kanban",
    }),
  });
  return created;
}

// ── Public API ───────────────────────────────────────────────────────────────

class MCSyncService {
  /**
   * Check if MC sync is configured (URL + token present).
   */
  static isEnabled() {
    return !!(MC_BACKEND_URL && MC_AUTH_TOKEN);
  }

  /**
   * After creating an agent_task, create a corresponding MC board task
   * and store the link (mc_task_id, mc_board_id) back into agent_tasks.
   *
   * @param {string} userId
   * @param {string} agentTaskId  - UUID of the newly created agent_task
   * @param {string} taskPrompt   - task description
   * @param {object} db           - database query function
   */
  static async syncNewTask(userId, agentTaskId, taskPrompt, db) {
    if (!this.isEnabled()) return null;

    try {
      const board = await getDefaultBoard(userId);
      if (!board) {
        console.warn("[mc-sync] Could not get/create default board");
        return null;
      }

      const title =
        taskPrompt.length > 200
          ? taskPrompt.substring(0, 197) + "..."
          : taskPrompt;

      const mcTask = await mcFetch(
        `/boards/${encodeURIComponent(board.id)}/tasks`,
        userId,
        {
          method: "POST",
          body: JSON.stringify({
            title,
            description: taskPrompt,
            status: "inbox",
            priority: "medium",
          }),
        }
      );

      if (!mcTask) {
        console.warn("[mc-sync] Failed to create MC task");
        return null;
      }

      // Link MC task back to agent_task
      await db(
        `UPDATE agent_tasks SET mc_task_id = $1, mc_board_id = $2, updated_at = NOW()
         WHERE id = $3`,
        [mcTask.id, board.id, agentTaskId]
      );

      console.log(
        `[mc-sync] ✅ Synced task ${agentTaskId} → MC task ${mcTask.id} on board ${board.id}`
      );
      return { mcTaskId: mcTask.id, mcBoardId: board.id };
    } catch (err) {
      console.error("[mc-sync] syncNewTask error:", err.message);
      return null;
    }
  }

  /**
   * After updating an agent_task status, push the new status to MC.
   *
   * @param {string} userId
   * @param {string} agentTaskId
   * @param {string} newAgentStatus - new agent_tasks status
   * @param {object} db             - database query function
   * @param {string} [errorMessage] - optional error for failed tasks
   */
  static async syncTaskStatus(userId, agentTaskId, newAgentStatus, db, errorMessage) {
    if (!this.isEnabled()) return false;

    try {
      const result = await db(
        `SELECT mc_task_id, mc_board_id FROM agent_tasks WHERE id = $1`,
        [agentTaskId]
      );
      const row = result.rows?.[0];
      if (!row?.mc_task_id || !row?.mc_board_id) return false;

      const mcStatus = AGENT_TO_MC_STATUS[newAgentStatus] || "inbox";

      // If failed, add a comment first
      if (newAgentStatus === "failed" && errorMessage) {
        await mcFetch(
          `/boards/${encodeURIComponent(row.mc_board_id)}/tasks/${encodeURIComponent(row.mc_task_id)}/comments`,
          userId,
          {
            method: "POST",
            body: JSON.stringify({
              content: `⚠️ Task failed: ${errorMessage}`,
            }),
          }
        );
      }

      const updated = await mcFetch(
        `/boards/${encodeURIComponent(row.mc_board_id)}/tasks/${encodeURIComponent(row.mc_task_id)}`,
        userId,
        {
          method: "PATCH",
          body: JSON.stringify({ status: mcStatus }),
        }
      );

      if (updated) {
        console.log(
          `[mc-sync] ✅ Status sync ${agentTaskId}: ${newAgentStatus} → MC ${mcStatus}`
        );
      }
      return updated !== null;
    } catch (err) {
      console.error("[mc-sync] syncTaskStatus error:", err.message);
      return false;
    }
  }

  /**
   * Append a short comment to an MC task. Used to surface per-action progress
   * (e.g. “✅ Created product …”) on the Mission Control task detail view.
   */
  static async appendTaskComment(userId, mcBoardId, mcTaskId, content) {
    if (!this.isEnabled() || !mcBoardId || !mcTaskId || !content) return false;
    try {
      const res = await mcFetch(
        `/boards/${encodeURIComponent(mcBoardId)}/tasks/${encodeURIComponent(mcTaskId)}/comments`,
        userId,
        {
          method: "POST",
          body: JSON.stringify({ content: String(content).slice(0, 1000) }),
        }
      );
      return res !== null;
    } catch (err) {
      console.error("[mc-sync] appendTaskComment error:", err.message);
      return false;
    }
  }

  /**
   * Convert MC status to agent_tasks status.
   */
  static mcStatusToAgent(mcStatus) {
    return MC_TO_AGENT_STATUS[mcStatus] || "pending";
  }

  /**
   * Convert agent_tasks status to MC status.
   */
  static agentStatusToMC(agentStatus) {
    return AGENT_TO_MC_STATUS[agentStatus] || "inbox";
  }
}

module.exports = MCSyncService;
