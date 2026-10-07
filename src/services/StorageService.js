/**
 * Storage Service — Google Cloud Storage operations for platform assets.
 *
 * Handles file uploads (avatars, post images, banners) to a shared
 * platform bucket with per-user path prefixes.  Also provisions
 * per-tenant buckets during the tenant onboarding flow.
 */

const { Storage } = require("@google-cloud/storage");
const crypto = require("node:crypto");
const path = require("node:path");
const config = require("../config");

// Allowed MIME types per upload category
const ALLOWED_TYPES = {
  avatar: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  image: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  banner: ["image/jpeg", "image/png", "image/webp"],
};

const MAX_DIMENSIONS = {
  avatar: { width: 512, height: 512 },
  banner: { width: 1920, height: 480 },
  image: { width: 4096, height: 4096 },
};

let storage = null;

function getStorage() {
  if (!storage) {
    storage = new Storage({ projectId: config.storage.projectId });
  }
  return storage;
}

function getBucket() {
  return getStorage().bucket(config.storage.bucket);
}

/**
 * Generate a unique object key for an upload.
 * Format: {category}/{userId}/{timestamp}-{random}.{ext}
 */
function generateKey(category, userId, originalName) {
  const ext = path.extname(originalName).toLowerCase() || ".bin";
  const rand = crypto.randomBytes(8).toString("hex");
  const ts = Date.now();
  return `${category}/${userId}/${ts}-${rand}${ext}`;
}

/**
 * Get the public URL for an object.
 */
function publicUrl(objectKey) {
  if (config.storage.cdnBaseUrl) {
    return `${config.storage.cdnBaseUrl}/${objectKey}`;
  }
  return `https://storage.googleapis.com/${config.storage.bucket}/${objectKey}`;
}

class StorageService {
  /**
   * Upload a file buffer to GCS.
   *
   * @param {Object} params
   * @param {Buffer} params.buffer   — File data
   * @param {string} params.mimeType — Content type
   * @param {string} params.category — "avatar" | "image" | "banner"
   * @param {string} params.userId   — Uploader user UUID
   * @param {string} params.originalName — Original filename (for extension)
   * @returns {Promise<{url: string, key: string, size: number}>}
   */
  static async upload({ buffer, mimeType, category, userId, originalName }) {
    const allowed = ALLOWED_TYPES[category];
    if (!allowed || !allowed.includes(mimeType)) {
      throw new Error(
        `Unsupported file type "${mimeType}" for ${category}. Allowed: ${(allowed || []).join(", ")}`
      );
    }

    if (buffer.length > config.storage.maxFileSize) {
      throw new Error(
        `File too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Max: ${(config.storage.maxFileSize / 1024 / 1024).toFixed(0)} MB`
      );
    }

    const key = generateKey(category, userId, originalName);
    const file = getBucket().file(key);

    await file.save(buffer, {
      contentType: mimeType,
      resumable: false,
      metadata: {
        cacheControl: "public, max-age=31536000, immutable",
        metadata: {
          uploadedBy: userId,
          category,
        },
      },
    });

    // Make publicly readable
    await file.makePublic();

    return {
      url: publicUrl(key),
      key,
      size: buffer.length,
    };
  }

  /**
   * Delete an object from GCS.
   *
   * @param {string} objectKey — Object key to delete
   */
  static async delete(objectKey) {
    if (!objectKey) return;
    const file = getBucket().file(objectKey);
    const [exists] = await file.exists();
    if (exists) {
      await file.delete();
    }
  }

  /**
   * Generate a signed upload URL (for direct client-side uploads).
   *
   * @param {Object} params
   * @param {string} params.category    — "avatar" | "image" | "banner"
   * @param {string} params.userId      — User UUID
   * @param {string} params.contentType — Expected MIME type
   * @param {string} params.fileName    — Original filename
   * @returns {Promise<{uploadUrl: string, key: string, publicUrl: string}>}
   */
  static async generateSignedUploadUrl({
    category,
    userId,
    contentType,
    fileName,
  }) {
    const allowed = ALLOWED_TYPES[category];
    if (!allowed || !allowed.includes(contentType)) {
      throw new Error(
        `Unsupported file type "${contentType}" for ${category}.`
      );
    }

    const key = generateKey(category, userId, fileName);
    const file = getBucket().file(key);

    const [url] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + 15 * 60 * 1000, // 15 minutes
      contentType,
    });

    return {
      uploadUrl: url,
      key,
      publicUrl: publicUrl(key),
    };
  }

  /**
   * Create a per-tenant GCS bucket.
   *
   * @param {string} subdomain — Tenant subdomain (e.g. "raj")
   * @param {string} region    — GCS location (default from config)
   * @returns {Promise<{bucketName: string, created: boolean}>}
   */
  static async createTenantBucket(subdomain, region) {
    const bucketName = `${config.storage.tenantBucketPrefix}-${subdomain}`;
    const bucket = getStorage().bucket(bucketName);

    const [exists] = await bucket.exists();
    if (exists) {
      return { bucketName, created: false };
    }

    await bucket.create({
      location: region || "europe-west1",
      storageClass: "STANDARD",
      iamConfiguration: {
        uniformBucketLevelAccess: { enabled: true },
      },
    });

    // Set lifecycle: delete temp files after 30 days
    await bucket.setMetadata({
      lifecycle: {
        rule: [
          {
            action: { type: "Delete" },
            condition: {
              age: 30,
              matchesPrefix: ["tmp/"],
            },
          },
        ],
      },
    });

    return { bucketName, created: true };
  }

  /**
   * Delete a per-tenant GCS bucket and all its contents.
   *
   * @param {string} subdomain — Tenant subdomain
   */
  static async deleteTenantBucket(subdomain) {
    const bucketName = `${config.storage.tenantBucketPrefix}-${subdomain}`;
    const bucket = getStorage().bucket(bucketName);

    const [exists] = await bucket.exists();
    if (!exists) return;

    // Delete all objects first, then the bucket
    await bucket.deleteFiles({ force: true });
    await bucket.delete();
  }
}

module.exports = StorageService;
