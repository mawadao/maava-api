/**
 * Wallet Service
 *
 * Business logic for PaySponge wallet integration — settings, balance
 * caching, approval-gated actions, and audit logging.
 */

const { queryOne, queryAll, transaction } = require("../config/database");
const {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} = require("../utils/errors");

const SPONGE_API_URL = process.env.SPONGE_API_URL || "https://api.wallet.paysponge.com";
const SPONGE_VERSION = "0.2.1";
const BALANCE_CACHE_TTL_MS = 60_000; // 60 seconds

class WalletService {
  // ─── Sponge HTTP helper ───────────────────────────────────────────

  static async _spongeRequest(method, path, apiKey, body) {
    const url = `${SPONGE_API_URL}${path}`;
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Sponge-Version": SPONGE_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(url, options);
    const data = await res.json().catch(() => null);

    if (!res.ok) {
      const msg = data?.error || `HTTP ${res.status}`;
      throw new BadRequestError(`PaySponge: ${msg}`, "SPONGE_API_ERROR");
    }

    return data;
  }

  // ─── Settings ─────────────────────────────────────────────────────

  static async getSettings(userId) {
    return queryOne(
      `SELECT * FROM wallet_settings WHERE user_id = $1`,
      [userId]
    );
  }

  static async upsertSettings(userId, sellerProfileId, data) {
    const existing = await this.getSettings(userId);

    if (existing) {
      const fields = [];
      const values = [];
      let idx = 1;

      const allowedFields = {
        spongeWalletId: "sponge_wallet_id",
        spongeKeyRef: "sponge_key_ref",
        isConnected: "is_connected",
        dailyLimit: "daily_limit",
        requireApproval: "require_approval",
        autoApproveMax: "auto_approve_max",
        allowedChains: "allowed_chains",
        metadata: "metadata",
      };

      for (const [jsKey, dbCol] of Object.entries(allowedFields)) {
        if (data[jsKey] !== undefined) {
          fields.push(`${dbCol} = $${idx}`);
          values.push(data[jsKey]);
          idx++;
        }
      }

      if (fields.length === 0) return existing;

      values.push(existing.id);
      return queryOne(
        `UPDATE wallet_settings SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
        values
      );
    }

    return queryOne(
      `INSERT INTO wallet_settings (
        user_id, seller_profile_id, sponge_wallet_id, sponge_key_ref,
        is_connected, daily_limit, require_approval, auto_approve_max,
        allowed_chains, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *`,
      [
        userId,
        sellerProfileId,
        data.spongeWalletId || null,
        data.spongeKeyRef || null,
        data.isConnected || false,
        data.dailyLimit || 1000.0,
        data.requireApproval !== undefined ? data.requireApproval : true,
        data.autoApproveMax || 10.0,
        data.allowedChains || ["base", "solana"],
        data.metadata || {},
      ]
    );
  }

  static async connectWallet(userId, sellerProfileId, spongeApiKey) {
    // Verify the key works by fetching balances
    const balances = await this._spongeRequest("GET", "/api/balances", spongeApiKey);

    // Store the key reference (in production, encrypt and store in a vault)
    const settings = await this.upsertSettings(userId, sellerProfileId, {
      spongeKeyRef: spongeApiKey,
      isConnected: true,
      spongeWalletId: balances?.walletId || null,
    });

    await this._auditLog(userId, "wallet_connected", {
      status: "success",
      actor: "user",
      details: { walletId: balances?.walletId },
    });

    return settings;
  }

  static async disconnectWallet(userId) {
    const settings = await this.getSettings(userId);
    if (!settings) throw new NotFoundError("Wallet settings");

    const updated = await queryOne(
      `UPDATE wallet_settings
       SET sponge_key_ref = NULL, is_connected = false, sponge_wallet_id = NULL
       WHERE user_id = $1 RETURNING *`,
      [userId]
    );

    await this._auditLog(userId, "wallet_disconnected", {
      status: "success",
      actor: "user",
    });

    return updated;
  }

  // ─── Balances ─────────────────────────────────────────────────────

  static async getBalances(userId, { chain, forceRefresh = false } = {}) {
    const settings = await this._requireConnected(userId);

    // Check cache first
    if (!forceRefresh) {
      const cached = await this._getCachedBalances(userId, chain);
      if (cached) return cached;
    }

    // Fetch from Sponge
    const query = chain ? `?chain=${encodeURIComponent(chain)}` : "";
    const balances = await this._spongeRequest(
      "GET",
      `/api/balances${query}`,
      settings.sponge_key_ref
    );

    // Cache results
    await this._cacheBalances(userId, balances);

    await this._auditLog(userId, "balance_check", {
      status: "success",
      chain,
      actor: "user",
    });

    return balances;
  }

  static async _getCachedBalances(userId, chain) {
    const staleThreshold = new Date(Date.now() - BALANCE_CACHE_TTL_MS).toISOString();

    if (chain) {
      const rows = await queryAll(
        `SELECT chain, token, balance, raw_response, fetched_at
         FROM wallet_balance_cache
         WHERE user_id = $1 AND fetched_at > $2::timestamptz AND chain = $3
         ORDER BY chain, token`,
        [userId, staleThreshold, chain]
      );
      return rows.length === 0 ? null : rows;
    }

    const rows = await queryAll(
      `SELECT chain, token, balance, raw_response, fetched_at
       FROM wallet_balance_cache
       WHERE user_id = $1 AND fetched_at > $2::timestamptz
       ORDER BY chain, token`,
      [userId, staleThreshold]
    );

    return rows.length === 0 ? null : rows;
  }

  static async _cacheBalances(userId, spongeResponse) {
    // Normalize Sponge response into individual chain/token rows
    const balances = spongeResponse?.balances || spongeResponse?.data || [];
    if (!Array.isArray(balances)) return;

    for (const entry of balances) {
      const chain = entry.chain || "unknown";
      const token = entry.token || entry.symbol || "USDC";
      const balance = entry.balance || entry.amount || 0;

      await queryOne(
        `INSERT INTO wallet_balance_cache (user_id, chain, token, balance, raw_response, fetched_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (user_id, chain, token)
         DO UPDATE SET balance = $4, raw_response = $5, fetched_at = NOW()`,
        [userId, chain, token, balance, JSON.stringify(entry)]
      );
    }
  }

  // ─── Transfers ────────────────────────────────────────────────────

  static async requestTransfer(userId, { to, amount, chain, currency = "USDC", requestedBy = "user" }) {
    const settings = await this._requireConnected(userId);
    await this._validateChain(settings, chain);

    const shouldAutoApprove = this._canAutoApprove(settings, amount, requestedBy);

    const action = await queryOne(
      `INSERT INTO wallet_pending_actions (
        user_id, action_type, amount, currency, chain, destination,
        params, status, requested_by
      ) VALUES ($1,'transfer',$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`,
      [
        userId, amount, currency, chain, to,
        JSON.stringify({ to, amount, chain, currency }),
        shouldAutoApprove ? "approved" : "pending",
        requestedBy,
      ]
    );

    if (shouldAutoApprove) {
      return this._executeAction(action, settings.sponge_key_ref);
    }

    await this._auditLog(userId, "transfer_requested", {
      actionId: action.id,
      amount,
      currency,
      chain,
      status: "pending",
      actor: requestedBy,
    });

    return action;
  }

  // ─── Swaps ────────────────────────────────────────────────────────

  static async requestSwap(userId, { from, to, amount, chain, requestedBy = "user" }) {
    const settings = await this._requireConnected(userId);
    await this._validateChain(settings, chain);

    const shouldAutoApprove = this._canAutoApprove(settings, amount, requestedBy);

    const action = await queryOne(
      `INSERT INTO wallet_pending_actions (
        user_id, action_type, amount, currency, chain, destination,
        params, status, requested_by
      ) VALUES ($1,'swap',$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`,
      [
        userId, amount, from, chain, to,
        JSON.stringify({ from, to, amount, chain }),
        shouldAutoApprove ? "approved" : "pending",
        requestedBy,
      ]
    );

    if (shouldAutoApprove) {
      return this._executeAction(action, settings.sponge_key_ref);
    }

    await this._auditLog(userId, "swap_requested", {
      actionId: action.id,
      amount,
      chain,
      status: "pending",
      actor: requestedBy,
    });

    return action;
  }

  // ─── Pending Actions ──────────────────────────────────────────────

  static async listPendingActions(userId, { status, actionType, limit = 25, offset = 0 } = {}) {
    const conditions = ["user_id = $1"];
    const values = [userId];
    let idx = 2;

    if (status) {
      conditions.push(`status = $${idx}`);
      values.push(status);
      idx++;
    }

    if (actionType) {
      conditions.push(`action_type = $${idx}`);
      values.push(actionType);
      idx++;
    }

    values.push(limit, offset);
    return queryAll(
      `SELECT * FROM wallet_pending_actions
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    );
  }

  static async approveAction(userId, actionId) {
    const action = await queryOne(
      `SELECT * FROM wallet_pending_actions WHERE id = $1 AND user_id = $2`,
      [actionId, userId]
    );
    if (!action) throw new NotFoundError("Pending action");
    if (action.status !== "pending") {
      throw new BadRequestError(`Action is already ${action.status}`);
    }

    const settings = await this._requireConnected(userId);

    const updated = await queryOne(
      `UPDATE wallet_pending_actions
       SET status = 'approved', approved_by = 'user'
       WHERE id = $1 RETURNING *`,
      [actionId]
    );

    // Execute immediately after approval
    return this._executeAction(updated, settings.sponge_key_ref);
  }

  static async rejectAction(userId, actionId, reason) {
    const action = await queryOne(
      `SELECT * FROM wallet_pending_actions WHERE id = $1 AND user_id = $2`,
      [actionId, userId]
    );
    if (!action) throw new NotFoundError("Pending action");
    if (action.status !== "pending") {
      throw new BadRequestError(`Action is already ${action.status}`);
    }

    const updated = await queryOne(
      `UPDATE wallet_pending_actions
       SET status = 'rejected', rejection_reason = $2
       WHERE id = $1 RETURNING *`,
      [actionId, reason || "Rejected by user"]
    );

    await this._auditLog(userId, `${action.action_type}_rejected`, {
      actionId: action.id,
      amount: action.amount,
      status: "rejected",
      actor: "user",
      details: { reason },
    });

    return updated;
  }

  // ─── Payment Links ────────────────────────────────────────────────

  static async createPaymentLink(userId, { amount, description, productId, callbackUrl }) {
    const settings = await this._requireConnected(userId);

    const linkData = await this._spongeRequest("POST", "/api/payment-links", settings.sponge_key_ref, {
      amount,
      description,
      callback_url: callbackUrl,
    });

    await this._auditLog(userId, "payment_link_created", {
      amount,
      currency: "USDC",
      status: "success",
      actor: "user",
      details: { paymentLinkId: linkData.id, productId },
    });

    return linkData;
  }

  // ─── Transaction History ──────────────────────────────────────────

  static async getTransactionHistory(userId, { chain, limit = 25, offset = 0 } = {}) {
    const settings = await this._requireConnected(userId);

    const query = new URLSearchParams();
    if (chain) query.set("chain", chain);
    if (limit) query.set("limit", String(limit));
    if (offset) query.set("offset", String(offset));
    const qs = query.toString();

    return this._spongeRequest(
      "GET",
      `/api/transactions${qs ? `?${qs}` : ""}`,
      settings.sponge_key_ref
    );
  }

  // ─── Audit Logs ───────────────────────────────────────────────────

  static async listAuditLogs(userId, { eventType, limit = 50, offset = 0 } = {}) {
    const conditions = ["user_id = $1"];
    const values = [userId];
    let idx = 2;

    if (eventType) {
      conditions.push(`event_type = $${idx}`);
      values.push(eventType);
      idx++;
    }

    values.push(limit, offset);
    return queryAll(
      `SELECT * FROM wallet_audit_logs
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    );
  }

  // ─── Daily Spend Tracking ─────────────────────────────────────────

  static async _getDailySpend(userId) {
    const result = await queryOne(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM wallet_pending_actions
       WHERE user_id = $1
         AND status IN ('approved', 'executed')
         AND created_at >= CURRENT_DATE`,
      [userId]
    );
    return Number(result?.total || 0);
  }

  // ─── Internal Helpers ─────────────────────────────────────────────

  static async _requireConnected(userId) {
    const settings = await this.getSettings(userId);
    if (!settings || !settings.is_connected || !settings.sponge_key_ref) {
      throw new BadRequestError(
        "Wallet not connected. Connect your PaySponge wallet first.",
        "WALLET_NOT_CONNECTED"
      );
    }
    return settings;
  }

  static async _validateChain(settings, chain) {
    if (chain && settings.allowed_chains && !settings.allowed_chains.includes(chain)) {
      throw new ForbiddenError(
        `Chain '${chain}' is not in your allowed chains: ${settings.allowed_chains.join(", ")}`
      );
    }
  }

  static _canAutoApprove(settings, amount, requestedBy) {
    if (requestedBy === "user") return true; // user-initiated always auto-approve
    if (!settings.require_approval) return true;
    if (Number(amount) <= Number(settings.auto_approve_max || 0)) return true;
    return false;
  }

  static async _executeAction(action, spongeApiKey) {
    const params = typeof action.params === "string"
      ? JSON.parse(action.params)
      : action.params;

    let result;
    try {
      switch (action.action_type) {
        case "transfer":
          result = await this._spongeRequest("POST", "/api/transfers", spongeApiKey, {
            to: params.to,
            amount: params.amount,
            chain: params.chain,
            currency: params.currency || "USDC",
          });
          break;

        case "swap":
          result = await this._spongeRequest("POST", "/api/swaps", spongeApiKey, {
            from_token: params.from,
            to_token: params.to,
            amount: params.amount,
            chain: params.chain,
          });
          break;

        case "bridge":
          result = await this._spongeRequest("POST", "/api/bridges", spongeApiKey, {
            from_chain: params.fromChain,
            to_chain: params.toChain,
            amount: params.amount,
            token: params.token || "USDC",
          });
          break;

        default:
          throw new BadRequestError(`Unknown action type: ${action.action_type}`);
      }

      await queryOne(
        `UPDATE wallet_pending_actions
         SET status = 'executed', executed_at = NOW(), result = $2
         WHERE id = $1 RETURNING *`,
        [action.id, JSON.stringify(result)]
      );

      await this._auditLog(action.user_id, `${action.action_type}_executed`, {
        actionId: action.id,
        amount: action.amount,
        currency: action.currency,
        chain: action.chain,
        status: "success",
        actor: action.approved_by || action.requested_by,
        details: result,
      });

      return { ...action, status: "executed", result };
    } catch (err) {
      await queryOne(
        `UPDATE wallet_pending_actions
         SET status = 'failed', error = $2
         WHERE id = $1`,
        [action.id, err.message]
      );

      await this._auditLog(action.user_id, `${action.action_type}_failed`, {
        actionId: action.id,
        amount: action.amount,
        status: "failed",
        actor: "system",
        details: { error: err.message },
      });

      throw err;
    }
  }

  static async _auditLog(userId, eventType, {
    actionId, orderId, amount, currency, chain, status, actor = "system", details, ipAddress,
  } = {}) {
    return queryOne(
      `INSERT INTO wallet_audit_logs (
        user_id, event_type, action_id, order_id, amount, currency,
        chain, status, actor, details, ip_address
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *`,
      [
        userId, eventType, actionId || null, orderId || null,
        amount || null, currency || null, chain || null,
        status || null, actor, details ? JSON.stringify(details) : "{}",
        ipAddress || null,
      ]
    );
  }
}

module.exports = WalletService;
