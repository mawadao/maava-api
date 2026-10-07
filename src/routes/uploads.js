/**
 * Upload Routes — File upload endpoints for avatars, images, and banners.
 *
 * POST /api/v1/uploads/avatar           — Upload avatar (user auth)
 * POST /api/v1/uploads/image            — Upload post/comment image (user auth)
 * POST /api/v1/uploads/banner           — Upload submolt/profile banner (user auth)
 * POST /api/v1/uploads/signed-url       — Get signed URL for direct upload (user auth)
 * DELETE /api/v1/uploads/:key           — Delete an uploaded file (user auth)
 */

const { Router } = require("express");
const multer = require("multer");
const path = require("path");
const { requireUserAuth } = require("../middleware/auth");
const { validate, t } = require("../middleware/validate");
const StorageService = require("../services/StorageService");
const config = require("../config");

const router = Router();

// Configure multer to store files in memory (buffers)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.storage.maxFileSize,
    files: 1,
  },
});

/**
 * Generic upload handler for a given category.
 */
function uploadHandler(category) {
  return async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "No file provided. Use form field name 'file'.",
        });
      }

      const result = await StorageService.upload({
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        category,
        userId: req.user.id,
        originalName: req.file.originalname,
      });

      res.status(201).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  };
}

// All upload routes require user authentication
router.use(requireUserAuth);

/** Upload an avatar image */
router.post("/avatar", upload.single("file"), uploadHandler("avatar"));

/** Upload a post/comment image */
router.post("/image", upload.single("file"), uploadHandler("image"));

/** Upload a banner image */
router.post("/banner", upload.single("file"), uploadHandler("banner"));

/**
 * Get a signed URL for direct client-side upload to GCS.
 * Body: { category, contentType, fileName }
 */
router.post("/signed-url", validate({
  body: {
    category: t.oneOf(['avatar', 'image', 'banner'], { required: true }),
    contentType: t.string({ required: true, max: 100, pattern: /^(image|video|application)\/.+$/, patternHint: 'must be a valid MIME type' }),
    fileName: t.string({ required: true, max: 255 }),
  },
}), async (req, res, next) => {
  try {
    const { category, contentType, fileName } = req.body;

    // Sanitize fileName — strip path components to prevent traversal
    const safeName = path.basename(fileName);

    const result = await StorageService.generateSignedUploadUrl({
      category,
      userId: req.user.id,
      contentType,
      fileName: safeName,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/**
 * Delete an uploaded file.
 * The key is passed as a URL-encoded path parameter.
 */
router.delete("/*", async (req, res, next) => {
  try {
    // Extract the full key from the URL path after /uploads/
    const objectKey = req.params[0];
    if (!objectKey) {
      return res.status(400).json({
        success: false,
        message: "Object key is required",
      });
    }

    // Only allow users to delete their own uploads
    // Normalize the key to prevent path traversal (../ or encoded variants)
    const normalized = path.posix.normalize(objectKey);
    if (normalized !== objectKey || normalized.includes('..')) {
      return res.status(400).json({
        success: false,
        message: "Invalid object key",
      });
    }
    if (!objectKey.startsWith(`${req.user.id}/`)) {
      return res.status(403).json({
        success: false,
        message: "You can only delete your own uploads",
      });
    }

    await StorageService.delete(objectKey);
    res.json({ success: true, message: "File deleted" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
