/**
 * ScheduledDeliveryWorker — in-process cron runner for `scheduled_deliveries`.
 *
 * Runs once per minute. For every active row whose `next_run_at` has passed,
 * it dispatches the delivery (by re-feeding a synthetic `[DELIVER]` block
 * through ActionExecutorService — same code path as immediate deliveries),
 * records the run, and recomputes `next_run_at` from the cron expression.
 *
 * Failures are captured into `last_error` and `fail_count` but never stop
 * the loop. Each tick processes at most BATCH rows to bound work.
 *
 * The worker is single-instance safe because configuration-api currently
 * runs at min_instances/max_instances = 1. If it ever scales horizontally
 * we should switch the SELECT to use `FOR UPDATE SKIP LOCKED`.
 */

const { query, queryAll, rlsStorage } = require("../config/database");
const { nextAfter } = require("../utils/cron");

let started = false;
let timer = null;
const TICK_MS = 60_000;
const BATCH = 25;

async function dispatchOne(row) {
  // Build a synthetic [DELIVER] block per platform and run through the
  // standard executor so all credential lookup + retry logic is reused.
  const platforms = Array.isArray(row.platforms) ? row.platforms : ["all"];
  const ActionExecutorService = require("../services/ActionExecutorService");
  const ActionEventService = require("../services/ActionEventService");

  const blockText = platforms
    .map(
      (p) =>
        `[DELIVER]\nplatform: ${p}\ntext: ${String(row.message_template).replace(/\n/g, " ")}\n[/DELIVER]`
    )
    .join("\n");

  // RLS: scope queries to the owning user
  return rlsStorage.run({ userId: row.user_id }, async () => {
    const result = await ActionExecutorService.executeAll(blockText, {
      userId: row.user_id,
      conversationId: row.conversation_id || null,
      agentTaskId: row.agent_task_id || null,
    });

    // Surface a single rolled-up event so the chat live feed shows the firing.
    await ActionEventService.record(
      {
        userId: row.user_id,
        conversationId: row.conversation_id || null,
        agentTaskId: row.agent_task_id || null,
      },
      {
        type: "SCHEDULED_RUN",
        status:
          result.results.some((r) => r.status === "success")
            ? "success"
            : "error",
        name: row.name,
      }
    );

    return result;
  });
}

async function tick() {
  let due = [];
  try {
    const res = await query(
      `SELECT id, user_id, agent_task_id, conversation_id, name,
              message_template, cron_expression, platforms,
              run_count, fail_count
         FROM scheduled_deliveries
        WHERE is_active = TRUE
          AND (next_run_at IS NULL OR next_run_at <= NOW())
        ORDER BY next_run_at NULLS FIRST
        LIMIT $1`,
      [BATCH]
    );
    due = res.rows || [];
  } catch (err) {
    // Table might not exist yet on first deploy
    console.error("[sched-worker] query failed:", err.message);
    return;
  }

  if (due.length === 0) return;
  console.log(`[sched-worker] dispatching ${due.length} due delivery/ies`);

  for (const row of due) {
    let ok = false;
    let errMsg = null;
    try {
      await dispatchOne(row);
      ok = true;
    } catch (err) {
      errMsg = err.message;
      console.error(`[sched-worker] dispatch ${row.id} failed:`, err.message);
    }

    // Compute next firing
    let nextRun = null;
    try {
      nextRun = nextAfter(row.cron_expression, new Date());
    } catch {
      /* ignore */
    }

    try {
      await query(
        `UPDATE scheduled_deliveries
            SET last_run_at = NOW(),
                next_run_at = $1,
                run_count   = run_count + 1,
                fail_count  = fail_count + $2,
                last_error  = $3,
                updated_at  = NOW()
          WHERE id = $4`,
        [nextRun, ok ? 0 : 1, ok ? null : errMsg, row.id]
      );
    } catch (err) {
      console.error(`[sched-worker] bookkeeping ${row.id} failed:`, err.message);
    }
  }
}

function start() {
  if (started) return;
  started = true;
  console.log(`[sched-worker] starting (tick=${TICK_MS}ms)`);
  // Run shortly after boot then every minute
  setTimeout(() => {
    void tick();
    timer = setInterval(() => {
      void tick();
    }, TICK_MS);
  }, 5_000);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

module.exports = { start, stop, _tick: tick };
