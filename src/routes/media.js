/**
 * Media proxy route — serves GCS files via HMAC-signed, time-limited URLs.
 *
 * Used by PublishingService to give Zernio (and other external consumers)
 * a publicly-downloadable URL.  Files are fetched through mawa-storage
 * (which has the GCS Storage Object Viewer role) rather than directly
 * from GCS — so mawa-api's own SA doesn't need storage permissions.
 */

const { Router } = require("express");
const crypto = require("crypto");

const router = Router();

const STORAGE_URL = process.env.STORAGE_URL || "";
const SHARED_BUCKET = process.env.GCS_SHARED_BUCKET || "mawa-data";
const HMAC_SECRET =
  process.env.MEDIA_PROXY_SECRET ||
  process.env.JWT_SECRET ||
  "development-secret-change-in-production";

const MIME_MAP = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/**
 * Get auth headers for mawa-storage (IAM identity token on Cloud Run).
 */
async function bmHeaders() {
  const h = {};
  if (process.env.STORAGE_API_SECRET) {
    h["X-Storage-Secret"] = process.env.STORAGE_API_SECRET;
  }
  if (process.env.K_SERVICE) {
    try {
      const metaUrl =
        `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity` +
        `?audience=${encodeURIComponent(STORAGE_URL)}`;
      const res = await fetch(metaUrl, {
        headers: { "Metadata-Flavor": "Google" },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) h["Authorization"] = `Bearer ${(await res.text()).trim()}`;
    } catch { /* local dev fallback */ }
  }
  return h;
}

/**
 * GET /api/v1/media/serve?path=<gcsPath>&exp=<timestamp>&sig=<hmac>
 *
 * Validates HMAC signature and expiry, then fetches the file from
 * mawa-storage and streams it to the caller.
 * No auth middleware — must be publicly reachable for Zernio to download.
 */
router.get("/serve", async (req, res) => {
  const { path: gcsPath, exp, sig } = req.query;

  if (!gcsPath || !exp || !sig) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  // Check expiry
  const expiry = parseInt(exp, 10);
  if (isNaN(expiry) || Date.now() > expiry) {
    return res.status(403).json({ error: "Link expired" });
  }

  // Validate HMAC
  const expectedSig = crypto
    .createHmac("sha256", HMAC_SECRET)
    .update(`${gcsPath}:${exp}`)
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    return res.status(403).json({ error: "Invalid signature" });
  }

  if (!STORAGE_URL) {
    console.error("[media-serve] STORAGE_URL not configured");
    return res.status(503).json({ error: "Media service unavailable" });
  }

  try {
    const bmUrl = `${STORAGE_URL}/api/v1/buckets/${encodeURIComponent(SHARED_BUCKET)}/files/${gcsPath}`;
    const headers = await bmHeaders();
    const bmRes = await fetch(bmUrl, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (!bmRes.ok) {
      console.error(`[media-serve] mawa-storage responded ${bmRes.status} for ${gcsPath}`);
      const status = bmRes.status === 404 ? 404 : 502;
      return res.status(status).json({ error: status === 404 ? "File not found" : "Failed to fetch file" });
    }

    // Content type from extension or upstream
    const ext = gcsPath.split(".").pop()?.toLowerCase() || "";
    const contentType = MIME_MAP[ext] || bmRes.headers.get("content-type") || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    if (bmRes.headers.get("content-length")) {
      res.setHeader("Content-Length", bmRes.headers.get("content-length"));
    }

    // Stream from mawa-storage → caller
    const reader = bmRes.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); return; }
        if (!res.write(value)) {
          await new Promise((r) => res.once("drain", r));
        }
      }
    };
    await pump();
  } catch (err) {
    console.error("[media-serve] Error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

module.exports = router;
