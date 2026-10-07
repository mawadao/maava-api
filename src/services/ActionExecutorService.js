/**
 * ActionExecutorService
 *
 * Server-side action block parser and executor.
 * Mirrors the action-block processing logic from tenant-dashboard route.ts
 * so OpenClaw can execute actions headlessly (cron, webhooks, Telegram, etc.)
 * without requiring the user to be online on the frontend.
 *
 * Authentication: callers must provide userId; RLS context is set by the
 * route/middleware before calling these methods.
 */

const { query, queryOne, queryAll, rlsStorage } = require("../config/database");
const SellerService = require("./SellerService");
const PublishingService = require("./PublishingService");
const ChannelService = require("./ChannelService");
const MCSyncService = require("./MCSyncService");
const ActionEventService = require("./ActionEventService");
const { nextAfter } = require("../utils/cron");

// ─── Constants ──────────────────────────────────────────────────────────────

const SELLER_SQL_ALLOWED_TABLES = new Set([
  "seller_profiles",
  "seller_categories",
  "products",
  "product_versions",
  "product_assets",
  "listing_outputs",
  "connected_social_accounts",
  "publishing_targets",
  "publishing_jobs",
  "publishing_results",
  "approval_requests",
  "promotion_rules",
  "campaign_runs",
]);

const SELLER_SQL_READONLY_TABLES = new Set(["seller_categories"]);

const ZERNIO_ALLOWED_ACTIONS = new Set([
  "list_accounts",
  "create_post",
  "get_post",
  "delete_post",
  "list_profiles",
]);

// ─── Generic key:value parser ───────────────────────────────────────────────

function parseKeyValueBlock(body) {
  const fields = {};
  const lines = body.split("\n");
  let currentKey = "";
  let currentValue = "";
  for (const line of lines) {
    const kv = line.match(/^\s*([\w_]+):\s*(.*)/);
    if (kv) {
      if (currentKey) fields[currentKey] = currentValue.trim();
      currentKey = kv[1];
      currentValue = kv[2];
    } else if (currentKey) {
      currentValue += "\n" + line;
    }
  }
  if (currentKey) fields[currentKey] = currentValue.trim();
  return fields;
}

// ─── Block Parsers ──────────────────────────────────────────────────────────

function parseCreateProductBlocks(fullText) {
  const blocks = [];
  const re = /\[CREATE_PRODUCT\]([\s\S]*?)\[\/CREATE_PRODUCT\]/gi;
  let m;
  while ((m = re.exec(fullText)) !== null) {
    const f = parseKeyValueBlock(m[1].trim());
    if (f.name) {
      blocks.push({
        name: f.name,
        summary: f.summary,
        description: f.description,
        price: f.price,
        pricingModel: f.pricing_model,
        currency: f.currency,
        targetAudience: f.target_audience,
        categoryId: f.category_id,
      });
    }
  }
  return blocks;
}

function parseUpdateProductBlocks(fullText) {
  const blocks = [];
  const re = /\[UPDATE_PRODUCT\]([\s\S]*?)\[\/UPDATE_PRODUCT\]/gi;
  let m;
  while ((m = re.exec(fullText)) !== null) {
    const f = parseKeyValueBlock(m[1].trim());
    if (f.product_id || f.product_name) {
      blocks.push({
        productId: f.product_id,
        productName: f.product_name,
        name: f.name,
        summary: f.summary,
        description: f.description,
        price: f.price,
        pricingModel: f.pricing_model,
        status: f.status,
        categoryId: f.category_id,
      });
    }
  }
  return blocks;
}

function parsePublishProductBlocks(fullText) {
  const blocks = [];
  const re = /\[PUBLISH_PRODUCT\]([\s\S]*?)\[\/PUBLISH_PRODUCT\]/gi;
  let m;
  while ((m = re.exec(fullText)) !== null) {
    const f = parseKeyValueBlock(m[1].trim());
    const platform = f.platform || f.channel || "";
    if (platform && (f.product_id || f.product_name)) {
      blocks.push({
        productId: f.product_id,
        productName: f.product_name,
        platform,
        caption: f.caption,
        imageUrl: f.image_url,
        listingOutputId: f.listing_output_id,
        publishingTargetId: f.publishing_target_id,
      });
    }
  }
  return blocks;
}

function parseCreateTaskBlocks(fullText) {
  const blocks = [];
  const re = /\[CREATE_TASK\]([\s\S]*?)\[\/CREATE_TASK\]/gi;
  let m;
  while ((m = re.exec(fullText)) !== null) {
    const f = parseKeyValueBlock(m[1].trim());
    const taskPrompt = f.task_prompt || "";
    const agentId = f.agent_id;
    const agentName = f.agent_name;
    if (taskPrompt && (agentId || agentName)) {
      blocks.push({
        agentId,
        agentName,
        taskPrompt,
        taskType: f.task_type,
        heartbeatInterval: f.heartbeat_interval,
        maxRuntimeHours: f.max_runtime_hours
          ? parseInt(f.max_runtime_hours, 10)
          : undefined,
      });
    }
  }
  return blocks;
}

function parseUpdateTaskBlocks(fullText) {
  const blocks = [];
  const re = /\[UPDATE_TASK\]([\s\S]*?)\[\/UPDATE_TASK\]/gi;
  let m;
  while ((m = re.exec(fullText)) !== null) {
    const f = parseKeyValueBlock(m[1].trim());
    const newStatus = f.status || f.new_status || "";
    if (newStatus) {
      blocks.push({
        taskId: f.task_id,
        taskPrompt: f.task_prompt,
        newStatus,
      });
    }
  }
  return blocks;
}

function parseSellerSqlBlocks(fullText) {
  const blocks = [];
  const regex = /\[SELLER_SQL\]([\s\S]*?)\[\/SELLER_SQL\]/gi;
  let m;
  while ((m = regex.exec(fullText)) !== null) {
    const inner = m[1];
    const get = (key) => {
      const kr = new RegExp(`^${key}:\\s*(.+)$`, "mi");
      return kr.exec(inner)?.[1]?.trim() ?? "";
    };
    const sqlMatch = inner.match(
      /^sql:\s*([\s\S]*?)(?=^(?:params|confirm):|\[\/SELLER_SQL\])/mi
    );
    const sqlValue = sqlMatch?.[1]?.trim() ?? get("sql");
    let params = [];
    try {
      const raw = get("params");
      if (raw) params = JSON.parse(raw);
    } catch {
      /* keep empty */
    }
    blocks.push({
      operation: get("operation").toUpperCase(),
      table: get("table"),
      description: get("description"),
      sql: sqlValue,
      params,
      confirm: get("confirm").toLowerCase() === "true",
    });
  }
  return blocks;
}

function parseZernioApiBlocks(fullText) {
  const blocks = [];
  const regex = /\[ZERNIO_API\]([\s\S]*?)\[\/ZERNIO_API\]/gi;
  let m;
  while ((m = regex.exec(fullText)) !== null) {
    const inner = m[1];
    const get = (key) => {
      const kr = new RegExp(`^${key}:\\s*(.+)$`, "mi");
      return kr.exec(inner)?.[1]?.trim() ?? "";
    };
    let params = {};
    try {
      const raw = get("params");
      if (raw) params = JSON.parse(raw);
    } catch {
      /* keep empty */
    }
    blocks.push({
      action: get("action").toLowerCase(),
      description: get("description"),
      params,
    });
  }
  return blocks;
}

function parseDeliverBlocks(fullText) {
  const blocks = [];
  const re = /\[DELIVER\]([\s\S]*?)\[\/DELIVER\]/gi;
  let m;
  while ((m = re.exec(fullText)) !== null) {
    const f = parseKeyValueBlock(m[1].trim());
    blocks.push({
      platform: (f.platform || "all").toLowerCase(),
      text: f.text || f.message || "",
    });
  }
  return blocks;
}

function parseScheduleBlocks(fullText) {
  const blocks = [];
  const re = /\[SCHEDULE_DELIVERY\]([\s\S]*?)\[\/SCHEDULE_DELIVERY\]/gi;
  let m;
  while ((m = re.exec(fullText)) !== null) {
    const f = parseKeyValueBlock(m[1].trim());
    blocks.push({
      name: f.name || "Scheduled delivery",
      platform: (f.platform || "all").toLowerCase(),
      schedule: f.schedule || f.cron || "",
      text: f.text || f.message || "",
    });
  }
  return blocks;
}

// ─── Cron helper ────────────────────────────────────────────────────────────

function normalizeCron(expr) {
  if (!expr) return "0 9 * * *"; // default: 9am daily
  const parts = expr.trim().split(/\s+/);
  if (parts.length === 5) return expr.trim();
  // Handle simple aliases
  const aliases = {
    hourly: "0 * * * *",
    daily: "0 9 * * *",
    weekly: "0 9 * * 1",
    monthly: "0 9 1 * *",
  };
  return aliases[expr.toLowerCase()] || "0 9 * * *";
}

// ─── Processors ─────────────────────────────────────────────────────────────

class ActionExecutorService {
  /**
   * Execute all action blocks found in the given text.
   *
   * @param {string} fullText    Raw AI response containing action blocks
   * @param {object} ctx         Execution context
   * @param {string} ctx.userId  User UUID (required)
   * @param {string|null} ctx.conversationId  Optional conversation ID for result messages
   * @param {string|null} ctx.agentTaskId     Optional agent_tasks.id for live-feed/MC linkage
   * @param {string|null} ctx.gatewayUrl      Optional gateway URL for task dispatch
   * @param {string|null} ctx.gatewayToken    Optional gateway auth token
   * @returns {Promise<object>}  Summary of executed blocks
   */
  static async executeAll(fullText, ctx) {
    const { userId, conversationId, agentTaskId, gatewayUrl, gatewayToken } = ctx;
    console.log(
      `[action-executor] ─── executeAll START ─── userId=${userId} textLen=${fullText.length}`
    );

    const tags = [
      "CREATE_PRODUCT",
      "UPDATE_PRODUCT",
      "PUBLISH_PRODUCT",
      "CREATE_TASK",
      "UPDATE_TASK",
      "DELIVER",
      "SCHEDULE_DELIVERY",
      "SELLER_SQL",
      "ZERNIO_API",
    ];
    const found = tags.filter((t) => fullText.includes(`[${t}]`));

    if (found.length === 0) {
      console.log("[action-executor] No action blocks detected.");
      return { executed: 0, results: [] };
    }

    console.log(`[action-executor] Tags found: [${found.join(", ")}]`);

    const results = [];
    const promises = [];

    if (
      fullText.includes("[DELIVER]") ||
      fullText.includes("[SCHEDULE_DELIVERY]")
    ) {
      promises.push(
        this._processDeliveryBlocks(fullText, userId, { conversationId, agentTaskId }).then((r) =>
          results.push(...r)
        )
      );
    }
    if (fullText.includes("[CREATE_PRODUCT]")) {
      promises.push(
        this._processCreateProductBlocks(fullText, userId).then((r) =>
          results.push(...r)
        )
      );
    }
    if (fullText.includes("[UPDATE_PRODUCT]")) {
      promises.push(
        this._processUpdateProductBlocks(fullText, userId).then((r) =>
          results.push(...r)
        )
      );
    }
    if (fullText.includes("[PUBLISH_PRODUCT]")) {
      promises.push(
        this._processPublishBlocks(fullText, userId).then((r) =>
          results.push(...r)
        )
      );
    }
    if (fullText.includes("[CREATE_TASK]")) {
      promises.push(
        this._processCreateTaskBlocks(fullText, userId).then((r) =>
          results.push(...r)
        )
      );
    }
    if (fullText.includes("[UPDATE_TASK]")) {
      promises.push(
        this._processUpdateTaskBlocks(
          fullText,
          userId,
          gatewayUrl,
          gatewayToken
        ).then((r) => results.push(...r))
      );
    }
    if (fullText.includes("[SELLER_SQL]")) {
      promises.push(
        this._processSellerSqlBlocks(fullText, userId, conversationId).then(
          (r) => results.push(...r)
        )
      );
    }
    if (fullText.includes("[ZERNIO_API]")) {
      promises.push(
        this._processZernioApiBlocks(fullText, userId, conversationId).then(
          (r) => results.push(...r)
        )
      );
    }

    const settled = await Promise.allSettled(promises);
    settled.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(`[action-executor] Processor #${i} REJECTED:`, r.reason);
        results.push({
          type: "error",
          message: String(r.reason?.message || r.reason),
        });
      }
    });

    // Record per-action live events → DB + MC comments (best-effort).
    try {
      await ActionEventService.recordBatch(
        { userId, conversationId, agentTaskId },
        results
      );
    } catch (err) {
      console.error("[action-executor] recordBatch error:", err.message);
    }

    console.log(
      `[action-executor] ─── executeAll END ─── ${results.length} result(s)`
    );
    return { executed: results.length, results };
  }

  // ─── CREATE_PRODUCT ─────────────────────────────────────────────────

  static async _processCreateProductBlocks(fullText, userId) {
    const blocks = parseCreateProductBlocks(fullText);
    const results = [];

    for (const block of blocks) {
      try {
        console.log(
          `[action-executor][create-product] Creating: "${block.name}"`
        );

        // Use SellerService directly — it handles profile validation internally
        const product = await SellerService.createProduct(userId, {
          name: block.name,
          summary: block.summary,
          description: block.description,
          price: block.price,
          pricingModel: block.pricingModel || "one_time",
          currency: block.currency || "USD",
          targetAudience: block.targetAudience,
          categoryId: block.categoryId,
        });

        console.log(
          `[action-executor][create-product] ✅ Created: id=${product.id}`
        );

        // Auto-create marketplace listing_output
        try {
          await query(
            `INSERT INTO listing_outputs (product_id, channel, title, body, hashtags, media_urls, metadata)
             VALUES ($1, 'marketplace', $2, $3, $4, $5, $6)`,
            [
              product.id,
              block.name,
              block.description || block.summary || "",
              [],
              [],
              {},
            ]
          );
        } catch (loErr) {
          console.warn(
            `[action-executor][create-product] Listing creation error:`,
            loErr.message
          );
        }

        results.push({
          type: "CREATE_PRODUCT",
          status: "success",
          productId: product.id,
          name: product.name,
        });
      } catch (err) {
        console.error(
          `[action-executor][create-product] ❌ Error creating "${block.name}":`,
          err.message
        );
        results.push({
          type: "CREATE_PRODUCT",
          status: "error",
          name: block.name,
          error: err.message,
        });
      }
    }
    return results;
  }

  // ─── UPDATE_PRODUCT ─────────────────────────────────────────────────

  static async _processUpdateProductBlocks(fullText, userId) {
    const blocks = parseUpdateProductBlocks(fullText);
    const results = [];

    for (const block of blocks) {
      try {
        let productId = block.productId;
        if (!productId && block.productName) {
          const row = await queryOne(
            `SELECT id FROM products WHERE user_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
            [userId, block.productName]
          );
          productId = row?.id;
          if (!productId) {
            results.push({
              type: "UPDATE_PRODUCT",
              status: "error",
              error: `Product not found: "${block.productName}"`,
            });
            continue;
          }
        }

        const data = {};
        if (block.name) data.name = block.name;
        if (block.summary) data.summary = block.summary;
        if (block.description) data.description = block.description;
        if (block.price) data.price = block.price;
        if (block.pricingModel) data.pricingModel = block.pricingModel;
        if (block.status) data.status = block.status;
        if (block.categoryId) data.categoryId = block.categoryId;

        if (Object.keys(data).length === 0) {
          results.push({
            type: "UPDATE_PRODUCT",
            status: "skipped",
            productId,
            reason: "No fields to update",
          });
          continue;
        }

        const updated = await SellerService.updateProduct(
          productId,
          userId,
          data
        );
        console.log(
          `[action-executor][update-product] ✅ Updated: id=${productId}`
        );
        results.push({
          type: "UPDATE_PRODUCT",
          status: "success",
          productId,
        });
      } catch (err) {
        console.error(
          `[action-executor][update-product] ❌ Error:`,
          err.message
        );
        results.push({
          type: "UPDATE_PRODUCT",
          status: "error",
          error: err.message,
        });
      }
    }
    return results;
  }

  // ─── PUBLISH_PRODUCT ────────────────────────────────────────────────

  static async _processPublishBlocks(fullText, userId) {
    const blocks = parsePublishProductBlocks(fullText);
    const results = [];

    for (const block of blocks) {
      try {
        let productId = block.productId;
        if (!productId && block.productName) {
          const row = await queryOne(
            `SELECT id FROM products WHERE user_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
            [userId, block.productName]
          );
          productId = row?.id;
          if (!productId) {
            results.push({
              type: "PUBLISH_PRODUCT",
              status: "error",
              error: `Product not found: "${block.productName}"`,
            });
            continue;
          }
        }

        // Resolve publishing target from platform
        let publishingTargetId = block.publishingTargetId;
        if (!publishingTargetId && block.platform) {
          const platformToTargetType = {
            instagram: ["instagram_account", "instagram"],
            facebook: ["facebook_page", "facebook"],
            linkedin: ["linkedin_page", "linkedin"],
            twitter: ["twitter_account", "twitter"],
            tiktok: ["tiktok_account", "tiktok"],
          };
          const targetTypes =
            platformToTargetType[block.platform.toLowerCase()] || [
              block.platform,
            ];
          const targetRow = await queryOne(
            `SELECT pt.id, csa.platform_account_id FROM publishing_targets pt
             JOIN connected_social_accounts csa ON pt.social_account_id = csa.id
             WHERE pt.user_id = $1 AND pt.is_active = true AND csa.is_active = true
               AND csa.platform_account_id IS NOT NULL
               AND (pt.target_type = ANY($2) OR LOWER(csa.platform) = LOWER($3))
             ORDER BY pt.is_default DESC, pt.created_at ASC
             LIMIT 1`,
            [userId, targetTypes, block.platform]
          );
          if (targetRow) {
            publishingTargetId = targetRow.id;
          } else {
            results.push({
              type: "PUBLISH_PRODUCT",
              status: "error",
              error: `No publishing target for platform="${block.platform}"`,
            });
            continue;
          }
        }

        // Auto-create listing_output if caption provided
        let listingOutputId = block.listingOutputId;
        if (!listingOutputId && productId && block.caption) {
          try {
            const assetRows = await queryAll(
              `SELECT file_url FROM product_assets WHERE product_id = $1 ORDER BY sort_order ASC`,
              [productId]
            );
            const mediaUrls = assetRows.map((r) => r.file_url);
            const captionLines = block.caption.split("\n");
            const title =
              captionLines[0]?.trim() || block.productName || "";
            const body =
              captionLines.slice(1).join("\n").trim() || block.caption;
            const hashtagMatches = block.caption.match(/#\w+/g) || [];

            const loRow = await queryOne(
              `INSERT INTO listing_outputs (product_id, channel, title, body, hashtags, media_urls)
               VALUES ($1, $2, $3, $4, $5, $6)
               RETURNING id`,
              [productId, block.platform, title, body, hashtagMatches, mediaUrls]
            );
            if (loRow) listingOutputId = loRow.id;
          } catch (loErr) {
            console.warn(
              `[action-executor][publish] listing_output error:`,
              loErr.message
            );
          }
        }

        // Use PublishingService to create and dispatch the job
        const job = await PublishingService.createJob({
          user_id: userId,
          product_id: productId,
          channel: block.platform,
          listing_output_id: listingOutputId || null,
          publishing_target_id: publishingTargetId || null,
        });

        console.log(
          `[action-executor][publish] ✅ Job created: id=${job.id}`
        );

        // Dispatch immediately
        try {
          await PublishingService.dispatchJob(job.id);
          console.log(
            `[action-executor][publish] ✅ Job dispatched: id=${job.id}`
          );
        } catch (dispatchErr) {
          console.warn(
            `[action-executor][publish] Dispatch deferred:`,
            dispatchErr.message
          );
        }

        results.push({
          type: "PUBLISH_PRODUCT",
          status: "success",
          jobId: job.id,
          productId,
          platform: block.platform,
        });
      } catch (err) {
        console.error(
          `[action-executor][publish] ❌ Error:`,
          err.message
        );
        results.push({
          type: "PUBLISH_PRODUCT",
          status: "error",
          error: err.message,
        });
      }
    }
    return results;
  }

  // ─── CREATE_TASK ────────────────────────────────────────────────────

  static async _processCreateTaskBlocks(fullText, userId) {
    const blocks = parseCreateTaskBlocks(fullText);
    const results = [];

    for (const block of blocks) {
      try {
        // Resolve agent_id from name/slug if needed
        let agentId = block.agentId;
        if (!agentId && block.agentName) {
          const row = await queryOne(
            `SELECT id FROM marketplace_agents WHERE LOWER(slug) = LOWER($1) OR LOWER(name) = LOWER($1) LIMIT 1`,
            [block.agentName]
          );
          agentId = row?.id;
          if (!agentId) {
            results.push({
              type: "CREATE_TASK",
              status: "error",
              error: `Agent not found: "${block.agentName}"`,
            });
            continue;
          }
        }

        const taskType = block.taskType || "one-shot";
        const heartbeat =
          taskType === "recurring"
            ? block.heartbeatInterval || "30m"
            : null;
        const maxHours = block.maxRuntimeHours || 24;

        const result = await query(
          `INSERT INTO agent_tasks (
             user_id, agent_id, task_prompt, task_type,
             status, heartbeat_interval, max_runtime_hours
           ) VALUES ($1, $2, $3, $4, 'pending', $5, $6)
           RETURNING *`,
          [userId, agentId, block.taskPrompt, taskType, heartbeat, maxHours]
        );
        const task = result.rows[0];
        console.log(
          `[action-executor][create-task] ✅ Task created: id=${task?.id}`
        );

        // Sync to Mission Control (fire-and-forget)
        if (task?.id) {
          MCSyncService.syncNewTask(userId, task.id, block.taskPrompt, query).catch((err) =>
            console.error("[action-executor][create-task] MC sync failed:", err.message)
          );
        }

        results.push({
          type: "CREATE_TASK",
          status: "success",
          taskId: task?.id,
        });
      } catch (err) {
        console.error(
          `[action-executor][create-task] ❌ Error:`,
          err.message
        );
        results.push({
          type: "CREATE_TASK",
          status: "error",
          error: err.message,
        });
      }
    }
    return results;
  }

  // ─── UPDATE_TASK ────────────────────────────────────────────────────

  static async _processUpdateTaskBlocks(
    fullText,
    userId,
    gatewayUrl,
    gatewayToken
  ) {
    const blocks = parseUpdateTaskBlocks(fullText);
    const results = [];
    const VALID_STATUSES = ["pending", "running", "completed", "cancelled"];
    const validTransitions = {
      pending: ["running", "cancelled"],
      running: ["completed", "cancelled"],
      failed: ["pending"],
      cancelled: ["pending"],
      completed: [],
    };

    for (const block of blocks) {
      try {
        let taskId = block.taskId;
        if (!taskId && block.taskPrompt) {
          const row = await queryOne(
            `SELECT id FROM agent_tasks WHERE user_id = $1 AND task_prompt ILIKE $2 LIMIT 1`,
            [userId, `%${block.taskPrompt.slice(0, 50)}%`]
          );
          taskId = row?.id;
          if (!taskId) {
            results.push({
              type: "UPDATE_TASK",
              status: "error",
              error: `Task not found by prompt`,
            });
            continue;
          }
        }

        if (!VALID_STATUSES.includes(block.newStatus)) {
          results.push({
            type: "UPDATE_TASK",
            status: "error",
            error: `Invalid status: "${block.newStatus}"`,
          });
          continue;
        }

        const existing = await queryOne(
          `SELECT id, status, task_prompt, agent_id FROM agent_tasks WHERE id = $1 AND user_id = $2`,
          [taskId, userId]
        );
        if (!existing) {
          results.push({
            type: "UPDATE_TASK",
            status: "error",
            error: `Task not found or not owned: ${taskId}`,
          });
          continue;
        }

        const allowed = validTransitions[existing.status] || [];
        if (!allowed.includes(block.newStatus)) {
          results.push({
            type: "UPDATE_TASK",
            status: "error",
            error: `Invalid transition: ${existing.status} → ${block.newStatus}`,
          });
          continue;
        }

        const extraFields =
          block.newStatus === "running"
            ? ", started_at = COALESCE(started_at, NOW())"
            : block.newStatus === "completed"
              ? ", completed_at = NOW(), progress = 100"
              : block.newStatus === "pending"
                ? ", error = NULL, result = NULL, progress = 0, started_at = NULL, completed_at = NULL"
                : block.newStatus === "cancelled"
                  ? ", completed_at = NOW()"
                  : "";

        await query(
          `UPDATE agent_tasks SET status = $1, updated_at = NOW()${extraFields}
           WHERE id = $2 AND user_id = $3`,
          [block.newStatus, taskId, userId]
        );

        console.log(
          `[action-executor][update-task] ✅ Task ${taskId}: ${existing.status} → ${block.newStatus}`
        );

        // Sync status to Mission Control (fire-and-forget)
        MCSyncService.syncTaskStatus(userId, taskId, block.newStatus, query).catch((err) =>
          console.error("[action-executor][update-task] MC sync failed:", err.message)
        );

        // If task → running and gateway available, dispatch
        if (block.newStatus === "running" && gatewayUrl) {
          this._dispatchTaskToGateway(
            taskId,
            existing.task_prompt,
            gatewayUrl,
            gatewayToken
          ).catch((err) =>
            console.error(
              "[action-executor][update-task] Gateway dispatch failed:",
              err
            )
          );
        }

        results.push({
          type: "UPDATE_TASK",
          status: "success",
          taskId,
          newStatus: block.newStatus,
        });
      } catch (err) {
        console.error(
          `[action-executor][update-task] ❌ Error:`,
          err.message
        );
        results.push({
          type: "UPDATE_TASK",
          status: "error",
          error: err.message,
        });
      }
    }
    return results;
  }

  // ─── DELIVER / SCHEDULE_DELIVERY ────────────────────────────────────

  static async _processDeliveryBlocks(fullText, userId, ctx = {}) {
    const results = [];
    const conversationId = ctx.conversationId || null;
    const agentTaskId = ctx.agentTaskId || null;

    // Immediate deliveries
    const deliverBlocks = parseDeliverBlocks(fullText);
    for (const block of deliverBlocks) {
      try {
        // Look up linked channels for the user
        const channels = await queryAll(
          `SELECT channel_type, credentials, is_active FROM agent_channels
           WHERE user_id = $1 AND is_active = true`,
          [userId]
        );

        // Also check dedicated tables
        const slackRows = await queryAll(
          `SELECT slack_team_name, slack_bot_token, slack_channel_id FROM slack_connections
           WHERE mawadao_user_id = $1 AND is_active = true`,
          [userId]
        );

        let delivered = 0;
        const errors = [];

        // Deliver to Slack
        if (
          block.platform === "all" ||
          block.platform === "slack"
        ) {
          for (const sc of slackRows) {
            if (sc.slack_bot_token && sc.slack_channel_id) {
              try {
                const resp = await fetch(
                  "https://slack.com/api/chat.postMessage",
                  {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${sc.slack_bot_token}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      channel: sc.slack_channel_id,
                      text: block.text,
                    }),
                  }
                );
                if (resp.ok) delivered++;
                else errors.push(`Slack: HTTP ${resp.status}`);
              } catch (e) {
                errors.push(`Slack: ${e.message}`);
              }
            }
          }
        }

        // Deliver to Telegram
        if (
          block.platform === "all" ||
          block.platform === "telegram"
        ) {
          // Check telegram_channel_links table
          const tgRows = await queryAll(
            `SELECT telegram_chat_id FROM telegram_channel_links
             WHERE mawadao_user_id = $1 AND is_active = true`,
            [userId]
          ).catch(() => []);

          // Check agent_channels for telegram
          const tgAgent = channels.filter(
            (c) => c.channel_type === "telegram"
          );

          const allTgChats = [
            ...tgRows.map((r) => ({
              chatId: r.telegram_chat_id,
              botToken: null,
            })),
            ...tgAgent.map((c) => ({
              chatId: c.credentials?.chat_id,
              botToken: c.credentials?.bot_token,
            })),
          ];

          // Use bot token from env or channel credentials
          const defaultBotToken =
            process.env.TELEGRAM_BOT_TOKEN || "";

          for (const tg of allTgChats) {
            const token = tg.botToken || defaultBotToken;
            if (!token || !tg.chatId) continue;
            try {
              const resp = await fetch(
                `https://api.telegram.org/bot${token}/sendMessage`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    chat_id: tg.chatId,
                    text: block.text,
                    parse_mode: "Markdown",
                  }),
                }
              );
              if (resp.ok) delivered++;
              else errors.push(`Telegram: HTTP ${resp.status}`);
            } catch (e) {
              errors.push(`Telegram: ${e.message}`);
            }
          }
        }

        if (delivered === 0 && errors.length === 0) {
          errors.push(
            `cron delivery target is missing — no connected ${
              block.platform === "all" ? "chat channel" : block.platform + " channel"
            } for this user. Connect at /channels.`
          );
        }
        results.push({
          type: "DELIVER",
          status: delivered > 0 ? "success" : "error",
          delivered,
          errors: errors.length > 0 ? errors : undefined,
          platform: block.platform,
        });
      } catch (err) {
        console.error(
          `[action-executor][deliver] ❌ Error:`,
          err.message
        );
        results.push({
          type: "DELIVER",
          status: "error",
          error: err.message,
        });
      }
    }

    // Scheduled deliveries
    const scheduleBlocks = parseScheduleBlocks(fullText);
    const SUPPORTED_SCHED_PLATFORMS = new Set([
      "slack",
      "telegram",
      "discord",
      "whatsapp",
      "all",
    ]);
    for (const block of scheduleBlocks) {
      try {
        // ── Validate platform ─────────────────────────────────────────
        if (!SUPPORTED_SCHED_PLATFORMS.has(block.platform)) {
          const msg = `[SCHEDULE_DELIVERY] platform "${block.platform}" is not a chat channel. ` +
            `Use one of: slack, telegram, discord, whatsapp, all. ` +
            `For social media scheduling (twitter, instagram, facebook, linkedin, tiktok, etc.) ` +
            `use [ZERNIO_API] action: create_post with the "scheduledFor" parameter instead.`;
          console.warn(`[action-executor][schedule] ⚠️ ${msg}`);
          results.push({
            type: "SCHEDULE_DELIVERY",
            status: "error",
            name: block.name,
            platform: block.platform,
            error: msg,
          });
          continue;
        }

        // ── Validate at least one matching channel is connected ───────
        const checkPlatforms =
          block.platform === "all"
            ? ["slack", "telegram", "discord", "whatsapp"]
            : [block.platform];
        const connected = new Set();
        try {
          const slackRows = await queryAll(
            `SELECT 1 FROM slack_connections
              WHERE mawadao_user_id = $1 AND is_active = true LIMIT 1`,
            [userId]
          );
          if (slackRows.length) connected.add("slack");
        } catch { /* ignore */ }
        try {
          const tgRows = await queryAll(
            `SELECT 1 FROM telegram_channel_links
              WHERE mawadao_user_id = $1 AND is_active = true LIMIT 1`,
            [userId]
          );
          if (tgRows.length) connected.add("telegram");
        } catch { /* ignore */ }
        try {
          const agentChans = await queryAll(
            `SELECT channel_type FROM agent_channels
              WHERE user_id = $1 AND is_active = true`,
            [userId]
          );
          for (const c of agentChans) {
            if (c.channel_type) connected.add(String(c.channel_type).toLowerCase());
          }
        } catch { /* ignore */ }

        const matched = checkPlatforms.filter((p) => connected.has(p));
        if (matched.length === 0) {
          const msg = `cron delivery target is missing — no connected ${
            block.platform === "all" ? "chat channel" : block.platform + " channel"
          }. Connect a channel at /channels first, then schedule again.`;
          console.warn(`[action-executor][schedule] ⚠️ ${msg}`);
          results.push({
            type: "SCHEDULE_DELIVERY",
            status: "error",
            name: block.name,
            platform: block.platform,
            error: msg,
          });
          continue;
        }

        const cronExpr = normalizeCron(block.schedule);
        const platforms =
          block.platform === "all"
            ? Array.from(matched)
            : [block.platform];

        const nextRun = nextAfter(cronExpr, new Date());
        await query(
          `INSERT INTO scheduled_deliveries
             (user_id, agent_task_id, conversation_id, name, message_template, cron_expression, platforms, next_run_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            userId,
            agentTaskId,
            conversationId,
            block.name,
            block.text,
            cronExpr,
            JSON.stringify(platforms),
            nextRun,
          ]
        );
        console.log(
          `[action-executor][schedule] ✅ Created: ${block.name} cron=${cronExpr} nextRun=${nextRun?.toISOString() || 'n/a'}`
        );
        results.push({
          type: "SCHEDULE_DELIVERY",
          status: "success",
          name: block.name,
          schedule: cronExpr,
          platform: block.platform,
        });
      } catch (err) {
        console.error(
          `[action-executor][schedule] ❌ Error:`,
          err.message
        );
        results.push({
          type: "SCHEDULE_DELIVERY",
          status: "error",
          error: err.message,
        });
      }
    }

    return results;
  }

  // ─── SELLER_SQL ─────────────────────────────────────────────────────

  static async _processSellerSqlBlocks(fullText, userId, conversationId) {
    const blocks = parseSellerSqlBlocks(fullText);
    const results = [];

    for (const block of blocks) {
      try {
        // Security validations
        if (!SELLER_SQL_ALLOWED_TABLES.has(block.table)) {
          results.push({
            type: "SELLER_SQL",
            status: "rejected",
            reason: `Table "${block.table}" not allowed`,
          });
          continue;
        }
        if (!["SELECT", "INSERT", "UPDATE", "DELETE"].includes(block.operation)) {
          results.push({
            type: "SELLER_SQL",
            status: "rejected",
            reason: `Operation "${block.operation}" not allowed`,
          });
          continue;
        }
        if (
          SELLER_SQL_READONLY_TABLES.has(block.table) &&
          block.operation !== "SELECT"
        ) {
          results.push({
            type: "SELLER_SQL",
            status: "rejected",
            reason: `Table "${block.table}" is read-only`,
          });
          continue;
        }
        // Block DDL
        if (
          /\b(CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE|CREATE\s+INDEX|DROP\s+INDEX)\b/i.test(
            block.sql
          )
        ) {
          results.push({
            type: "SELLER_SQL",
            status: "rejected",
            reason: "DDL not allowed",
          });
          continue;
        }
        // Block token columns
        if (/access_token_enc|refresh_token_enc/i.test(block.sql)) {
          results.push({
            type: "SELLER_SQL",
            status: "rejected",
            reason: "Encrypted token columns not accessible",
          });
          continue;
        }
        // DELETE must have WHERE
        if (block.operation === "DELETE" && !/\bWHERE\b/i.test(block.sql)) {
          results.push({
            type: "SELLER_SQL",
            status: "rejected",
            reason: "DELETE requires WHERE clause",
          });
          continue;
        }
        // Check referenced tables
        const fromPattern = /\b(?:FROM|JOIN|INTO|UPDATE)\s+(\w+)/gi;
        let tableMatch;
        let tableSafe = true;
        while ((tableMatch = fromPattern.exec(block.sql)) !== null) {
          const refTable = tableMatch[1].toLowerCase();
          if (
            !SELLER_SQL_ALLOWED_TABLES.has(refTable) &&
            !["json_build_object", "json_agg", "count", "json_build_array"].includes(
              refTable
            )
          ) {
            results.push({
              type: "SELLER_SQL",
              status: "rejected",
              reason: `References disallowed table "${refTable}"`,
            });
            tableSafe = false;
            break;
          }
        }
        if (!tableSafe) continue;

        // Replace {{USER_ID}} placeholder
        const resolvedParams = block.params.map((p) =>
          typeof p === "string"
            ? p.replace(/\{\{USER_ID\}\}/g, userId)
            : p
        );

        const qResult = await query(block.sql, resolvedParams);
        const rows = qResult.rows;
        console.log(
          `[action-executor][seller-sql] ✅ ${block.operation} on ${block.table}: ${rows.length} row(s)`
        );

        const desc = block.description || `${block.operation} on ${block.table}`;
        let resultData;
        if (block.operation === "SELECT") {
          const jsonStr = JSON.stringify(rows, null, 2);
          resultData =
            jsonStr.length > 4000
              ? jsonStr.slice(0, 4000) + `\n... (${rows.length} total, truncated)`
              : jsonStr;
        } else {
          resultData = `${rows.length} row(s) affected`;
        }

        // Save results to conversation if available
        if (conversationId) {
          try {
            const resultMessage =
              block.operation === "SELECT"
                ? `📊 **${desc}** (${rows.length} row${rows.length !== 1 ? "s" : ""}):\n\`\`\`json\n${resultData}\n\`\`\``
                : `📊 **${desc}**: ✅ ${resultData}`;
            await query(
              `INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'assistant', $2)`,
              [conversationId, resultMessage]
            );
          } catch (msgErr) {
            console.warn(
              "[action-executor][seller-sql] Failed to save result message:",
              msgErr.message
            );
          }
        }

        results.push({
          type: "SELLER_SQL",
          status: "success",
          description: desc,
          rowCount: rows.length,
          data: block.operation === "SELECT" ? rows.slice(0, 50) : undefined,
        });
      } catch (err) {
        console.error(
          `[action-executor][seller-sql] ❌ Error:`,
          err.message
        );
        results.push({
          type: "SELLER_SQL",
          status: "error",
          error: err.message,
        });
      }
    }
    return results;
  }

  // ─── ZERNIO_API ─────────────────────────────────────────────────────

  static async _processZernioApiBlocks(fullText, userId, conversationId) {
    const blocks = parseZernioApiBlocks(fullText);
    const results = [];

    for (const block of blocks) {
      try {
        if (!ZERNIO_ALLOWED_ACTIONS.has(block.action)) {
          results.push({
            type: "ZERNIO_API",
            status: "rejected",
            reason: `Action "${block.action}" not allowed`,
          });
          continue;
        }

        console.log(
          `[action-executor][zernio] Calling Zernio: action=${block.action}`
        );

        // Use the same approach as the seller/zernio/proxy route
        const { getZernioService } = require("./ZernioService");
        const zernio = getZernioService();

        // Get user's Zernio profile
        const zernioProfileId = await SellerService.getOrCreateZernioProfile(userId);

        let data;
        switch (block.action) {
          case "list_accounts":
            data = await zernio.listAccounts(zernioProfileId);
            break;
          case "list_profiles":
            data = await zernio.listProfiles();
            break;
          case "create_post":
            data = await zernio.createPost(zernioProfileId, block.params);
            break;
          case "get_post":
            data = await zernio.getPost(block.params.postId || block.params.post_id);
            break;
          case "delete_post":
            data = await zernio.deletePost(block.params.postId || block.params.post_id);
            break;
          default:
            throw new Error(`Unknown Zernio action: ${block.action}`);
        }

        const desc = block.description || block.action;
        const jsonStr = JSON.stringify(data, null, 2);

        if (conversationId) {
          try {
            const capped =
              jsonStr.length > 4000
                ? jsonStr.slice(0, 4000) + "\n... (truncated)"
                : jsonStr;
            await query(
              `INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'assistant', $2)`,
              [
                conversationId,
                `📱 **${desc}**:\n\`\`\`json\n${capped}\n\`\`\``,
              ]
            );
          } catch (msgErr) {
            console.warn(
              "[action-executor][zernio] Failed to save result:",
              msgErr.message
            );
          }
        }

        results.push({
          type: "ZERNIO_API",
          status: "success",
          action: block.action,
          data: data,
        });
      } catch (err) {
        console.error(
          `[action-executor][zernio] ❌ Error:`,
          err.message
        );
        results.push({
          type: "ZERNIO_API",
          status: "error",
          action: block.action,
          error: err.message,
        });
      }
    }
    return results;
  }

  // ─── Task gateway dispatch (internal) ───────────────────────────────

  static async _dispatchTaskToGateway(
    taskId,
    taskPrompt,
    gatewayUrl,
    gatewayToken
  ) {
    const chatUrl = `${gatewayUrl.replace(/\/+$/, "")}/v1/chat/completions`;
    console.log(
      `[action-executor][task-dispatch] Dispatching task ${taskId} to: ${chatUrl}`
    );

    const headers = { "Content-Type": "application/json" };
    if (gatewayToken) headers["Authorization"] = `Bearer ${gatewayToken}`;

    const res = await fetch(chatUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "openclaw",
        messages: [
          {
            role: "system",
            content: `You are executing an agent task (task_id: ${taskId}). Complete the task and report your result.`,
          },
          { role: "user", content: taskPrompt },
        ],
        stream: false,
        max_tokens: 16384,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (res.ok) {
      const data = await res.json();
      const result = data?.choices?.[0]?.message?.content || "";
      console.log(
        `[action-executor][task-dispatch] Task ${taskId} completed, result length: ${result.length}`
      );
      await query(
        `UPDATE agent_tasks SET status = 'completed', result = $1, completed_at = NOW(), progress = 100, updated_at = NOW()
         WHERE id = $2`,
        [result.slice(0, 50000), taskId]
      );
    } else {
      const errText = await res.text();
      console.error(
        `[action-executor][task-dispatch] Task ${taskId} failed: status=${res.status}`
      );
      await query(
        `UPDATE agent_tasks SET status = 'failed', error = $1, updated_at = NOW()
         WHERE id = $2`,
        [errText.slice(0, 2000), taskId]
      );
    }
  }
}

module.exports = ActionExecutorService;
