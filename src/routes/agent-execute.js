/**
 * Agent Execute Route
 *
 * POST /api/v1/agent/execute
 *
 * Accepts raw AI response text containing action blocks and executes them
 * server-side. This enables headless/offline execution — mawaDao Agent cron jobs,
 * webhooks, Telegram bots, and scheduled tasks can all trigger actions
 * without requiring the user to be on the frontend.
 *
 * Authentication: INTERNAL_API_SECRET + X-User-ID (same as seller routes).
 * mawaDao Agent sends:
 *   Authorization: Bearer <INTERNAL_API_SECRET>
 *   X-User-ID: <target-user-uuid>
 */

const { Router } = require("express");
const { requireInternalAuth } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/errorHandler");
const { BadRequestError } = require("../utils/errors");
const ActionExecutorService = require("../services/ActionExecutorService");

const router = Router();

/**
 * POST /api/v1/agent/execute
 *
 * Body:
 *   text: string              — Raw AI response containing action blocks
 *   conversationId?: string   — Optional conversation ID (for saving SQL/Zernio results)
 *   gatewayUrl?: string       — Optional gateway URL (for task dispatch)
 *   gatewayToken?: string     — Optional gateway auth token
 *
 * Returns:
 *   { ok: true, executed: number, results: [...] }
 */
router.post(
  "/execute",
  requireInternalAuth,
  asyncHandler(async (req, res) => {
    const { text, conversationId, agentTaskId, gatewayUrl, gatewayToken } = req.body;

    if (!text || typeof text !== "string") {
      throw new BadRequestError(
        "Missing required field: text (raw AI response with action blocks)"
      );
    }

    // Cap payload to prevent abuse (1 MB)
    if (text.length > 1_048_576) {
      throw new BadRequestError("Text payload exceeds 1 MB limit");
    }

    const userId = req.user.id;
    console.log(
      `[agent-execute] POST /execute userId=${userId} textLen=${text.length}`
    );

    const result = await ActionExecutorService.executeAll(text, {
      userId,
      conversationId: conversationId || null,
      agentTaskId: agentTaskId || null,
      gatewayUrl: gatewayUrl || null,
      gatewayToken: gatewayToken || null,
    });

    res.json({
      ok: true,
      executed: result.executed,
      results: result.results,
    });
  })
);

module.exports = router;
