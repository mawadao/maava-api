/**
 * Zernio Service
 *
 * HTTP client for the Zernio unified social media API.
 * Handles: OAuth connect flows, profile/account management, post creation.
 *
 * Docs: https://docs.zernio.com
 * Base URL: https://zernio.com/api/v1
 */

const config = require("../config");
const { BadRequestError } = require("../utils/errors");

class ZernioService {
  /**
   * @param {string} [apiKey] — optional override; defaults to the system-wide key from config
   */
  constructor(apiKey) {
    const key = apiKey || config.zernio.apiKey;
    if (!key) throw new BadRequestError("Zernio API key is not configured. Set the ZERNIO_API_KEY environment variable.");
    this.apiKey = key;
    this.baseUrl = config.zernio.baseUrl;
    this.callbackUrl = config.zernio.callbackUrl;
  }

  async _request(method, path, { body = null, query = null, headers: extraHeaders = {} } = {}) {
    let url = `${this.baseUrl}${path}`;
    if (query) {
      const qs = new URLSearchParams(
        Object.entries(query).filter(([, v]) => v != null)
      ).toString();
      if (qs) url += `?${qs}`;
    }

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      ...extraHeaders,
    };

    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(url, options);
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      // Extract the most useful error message from Zernio's response
      let errorMsg = `HTTP ${response.status}`;
      if (data) {
        // Zernio may return: { message, error, errors: [...], details }
        if (typeof data.message === "string") errorMsg = data.message;
        else if (typeof data.error === "string") errorMsg = data.error;
        if (Array.isArray(data.errors) && data.errors.length > 0) {
          const details = data.errors
            .map((e) => (typeof e === "string" ? e : e.message || e.error || JSON.stringify(e)))
            .join("; ");
          errorMsg += ` — ${details}`;
        }
        if (data.details && typeof data.details === "string") {
          errorMsg += ` (${data.details})`;
        }
      }
      const err = new Error(`Zernio API error: ${errorMsg}`);
      err.status = response.status;
      err.providerResponse = data;
      throw err;
    }

    return data;
  }

  // ─── Profiles ───────────────────────────────────────────────────

  async listProfiles() {
    return this._request("GET", "/profiles");
  }

  async createProfile(name, description = null, color = null) {
    const body = { name };
    if (description) body.description = description;
    if (color) body.color = color;
    return this._request("POST", "/profiles", { body });
  }

  async deleteProfile(profileId) {
    return this._request("DELETE", `/profiles/${encodeURIComponent(profileId)}`);
  }

  // ─── Accounts ───────────────────────────────────────────────────

  async listAccounts(profileId) {
    return this._request("GET", `/profiles/${encodeURIComponent(profileId)}/accounts`);
  }

  async deleteAccount(accountId) {
    return this._request("DELETE", `/accounts/${encodeURIComponent(accountId)}`);
  }

  // ─── OAuth Connect Flow ─────────────────────────────────────────

  /**
   * Step 1: Get the OAuth authorization URL for a platform.
   * Returns { authUrl, state }
   */
  async getConnectUrl(platform, profileId, redirectUrl = null) {
    return this._request("GET", `/connect/${encodeURIComponent(platform)}`, {
      query: {
        profileId,
        redirect_url: redirectUrl || this.callbackUrl,
      },
    });
  }

  /**
   * Step 2: Complete OAuth callback — exchange code for account connection.
   * Returns { accountId, platform, username, displayName, isActive }
   */
  async handleOAuthCallback(platform, { code, state, profileId }) {
    return this._request("POST", `/connect/${encodeURIComponent(platform)}`, {
      body: { code, state, profileId },
    });
  }

  // ─── Platform-Specific Selection ────────────────────────────────

  /** Facebook: list available pages after initial OAuth */
  async listFacebookPages(profileId, tempToken) {
    return this._request("GET", "/connect/facebook/select-page", {
      query: { profileId, tempToken },
    });
  }

  /** Facebook: select a specific page to connect */
  async selectFacebookPage({ profileId, pageId, tempToken, userProfile, redirectUrl }) {
    return this._request("POST", "/connect/facebook/select-page", {
      body: {
        profileId,
        pageId,
        tempToken,
        userProfile: userProfile || undefined,
        redirect_url: redirectUrl || undefined,
      },
    });
  }

  /** Google Business: list available locations */
  async listGoogleBusinessLocations(profileId, tempToken) {
    return this._request("GET", "/connect/googlebusiness/locations", {
      query: { profileId, tempToken },
    });
  }

  /** Google Business: select a specific location */
  async selectGoogleBusinessLocation({ profileId, locationId, tempToken, userProfile, redirectUrl }) {
    return this._request("POST", "/connect/googlebusiness/select-location", {
      body: {
        profileId,
        locationId,
        tempToken,
        userProfile: userProfile || undefined,
        redirect_url: redirectUrl || undefined,
      },
    });
  }

  // ─── Posts ──────────────────────────────────────────────────────

  /**
   * Create a post targeting one or more platform accounts.
   *
   * @param {Object} params
   * @param {Array<{platform:string, accountId:string, customContent?:string}>} params.platforms
   * @param {string} [params.content] - Shared content across all platforms
   * @param {Array<{type:string, url:string}>} [params.mediaItems]
   * @param {string} [params.scheduledFor] - ISO-8601 datetime
   * @param {boolean} [params.publishNow]
   * @param {string[]} [params.tags]
   * @param {string[]} [params.hashtags]
   * @param {Object} [params.metadata]
   */
  async createPost({
    platforms,
    content = null,
    title = null,
    mediaItems = [],
    scheduledFor = null,
    publishNow = true,
    tags = [],
    hashtags = [],
    metadata = {},
  }) {
    const body = { platforms };
    if (content) body.content = content;
    if (title) body.title = title;
    if (mediaItems.length) body.mediaItems = mediaItems;
    if (scheduledFor) {
      body.scheduledFor = new Date(scheduledFor).toISOString();
      body.publishNow = false;
    } else {
      body.publishNow = publishNow;
    }
    if (tags.length) body.tags = tags;
    if (hashtags.length) body.hashtags = hashtags;
    if (Object.keys(metadata).length) body.metadata = metadata;

    return this._request("POST", "/posts", { body });
  }

  /** Get a single post */
  async getPost(postId) {
    return this._request("GET", `/posts/${encodeURIComponent(postId)}`);
  }

  /** Delete/cancel a post */
  async deletePost(postId) {
    return this._request("DELETE", `/posts/${encodeURIComponent(postId)}`);
  }
}

/**
 * Create a ZernioService with an optional API key override.
 * Without arguments, uses the system-wide ZERNIO_API_KEY.
 */
function createZernioService(apiKey) {
  return new ZernioService(apiKey);
}

/** Singleton instance — all users share the system-wide API key. */
let _instance = null;

/**
 * Get the shared ZernioService instance (system-wide API key).
 * Per-user isolation is handled by Zernio profiles, not by separate API keys.
 */
function getZernioService() {
  if (!_instance) _instance = new ZernioService();
  return _instance;
}

/**
 * Backwards-compatible alias — userId is accepted but ignored.
 * The system-wide API key is used for all users.
 */
async function getZernioServiceForUser(_userId) {
  return getZernioService();
}

module.exports = { ZernioService, createZernioService, getZernioService, getZernioServiceForUser };
