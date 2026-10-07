/**
 * Centralized input validation middleware.
 *
 * Lightweight schema-based validator — no external dependencies.
 * Uses the existing ValidationError class for consistent error responses.
 */

const { ValidationError, BadRequestError } = require('../utils/errors');

// ── helpers ───────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR_HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
const SAFE_STRING_RE = /^[\x20-\x7E\u00A0-\uFFFF]*$/; // printable + unicode, no control chars

function isUUID(v) { return typeof v === 'string' && UUID_RE.test(v); }

/** Strip leading/trailing whitespace + collapse internal runs. */
function sanitize(v) {
  if (typeof v !== 'string') return v;
  return v.trim().replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); // strip control chars except \t \n \r
}

// ── field rule builders ───────────────────────────────────────────────

/**
 * Each rule builder returns { validate(value) → errorMsg|null, sanitize?, ... }
 */

const t = {
  /** Required string with optional min/max length and regex. */
  string({ required = false, min, max, pattern, patternHint, trim = true } = {}) {
    return {
      type: 'string', required, trim,
      validate(v) {
        if (v == null || v === '') return required ? 'is required' : null;
        if (typeof v !== 'string') return 'must be a string';
        const s = trim ? v.trim() : v;
        if (required && s === '') return 'is required';
        if (min != null && s.length < min) return `must be at least ${min} characters`;
        if (max != null && s.length > max) return `must be at most ${max} characters`;
        if (pattern && !pattern.test(s)) return patternHint || 'has invalid format';
        return null;
      },
    };
  },

  /** UUID string. */
  uuid({ required = false } = {}) {
    return {
      type: 'uuid', required,
      validate(v) {
        if (v == null || v === '') return required ? 'is required' : null;
        if (!isUUID(v)) return 'must be a valid UUID';
        return null;
      },
    };
  },

  /** Integer with optional min/max. */
  integer({ required = false, min, max } = {}) {
    return {
      type: 'integer', required,
      validate(v) {
        if (v == null || v === '') return required ? 'is required' : null;
        const n = typeof v === 'string' ? Number(v) : v;
        if (!Number.isInteger(n)) return 'must be an integer';
        if (min != null && n < min) return `must be at least ${min}`;
        if (max != null && n > max) return `must be at most ${max}`;
        return null;
      },
    };
  },

  /** Enum — value must be one of the allowed values. */
  oneOf(values, { required = false } = {}) {
    return {
      type: 'enum', required,
      validate(v) {
        if (v == null || v === '') return required ? 'is required' : null;
        if (!values.includes(v)) return `must be one of: ${values.join(', ')}`;
        return null;
      },
    };
  },

  /** URL string. */
  url({ required = false, max = 2048 } = {}) {
    return {
      type: 'url', required,
      validate(v) {
        if (v == null || v === '') return required ? 'is required' : null;
        if (typeof v !== 'string') return 'must be a string';
        if (v.length > max) return `must be at most ${max} characters`;
        try {
          const parsed = new URL(v);
          if (!['http:', 'https:'].includes(parsed.protocol)) return 'must use http or https';
        } catch {
          return 'must be a valid URL';
        }
        return null;
      },
    };
  },

  /** Hex color code. */
  color({ required = false } = {}) {
    return {
      type: 'color', required,
      validate(v) {
        if (v == null || v === '') return required ? 'is required' : null;
        if (typeof v !== 'string') return 'must be a string';
        if (!COLOR_HEX_RE.test(v)) return 'must be a valid hex color (e.g. #ff0000)';
        return null;
      },
    };
  },

  /** Plain object (JSON). Optional maxKeys / maxBytes. */
  object({ required = false, maxKeys = 50, maxBytes = 10240 } = {}) {
    return {
      type: 'object', required,
      validate(v) {
        if (v == null) return required ? 'is required' : null;
        if (typeof v !== 'object' || Array.isArray(v)) return 'must be a JSON object';
        if (Object.keys(v).length > maxKeys) return `must have at most ${maxKeys} keys`;
        if (JSON.stringify(v).length > maxBytes) return `must be at most ${Math.round(maxBytes / 1024)}KB`;
        return null;
      },
    };
  },
};

// ── middleware factory ────────────────────────────────────────────────

/**
 * Validate request inputs against a schema.
 *
 * @param {Object} schema - { body, params, query } each mapping field → rule
 * @returns Express middleware that throws ValidationError on failure
 *
 * Usage:
 *   router.post('/agents/register', validate({
 *     body: {
 *       name: t.string({ required: true, min: 2, max: 32, pattern: /^[a-z0-9_]+$/i }),
 *       password: t.string({ required: true, min: 6, max: 128 }),
 *       description: t.string({ max: 2000 }),
 *     }
 *   }), asyncHandler(async (req, res) => { ... }));
 */
function validate(schema) {
  return (req, _res, next) => {
    const errors = [];

    for (const source of ['body', 'params', 'query']) {
      const rules = schema[source];
      if (!rules) continue;

      const data = req[source] || {};

      for (const [field, rule] of Object.entries(rules)) {
        let value = data[field];

        // Sanitize strings
        if (typeof value === 'string') {
          value = sanitize(value);
          if (rule.trim !== false) value = value.trim();
          data[field] = value; // write sanitized value back
        }

        const msg = rule.validate(value);
        if (msg) {
          errors.push({ field: `${source}.${field}`, message: `${field} ${msg}` });
        }
      }
    }

    if (errors.length > 0) {
      throw new ValidationError(errors);
    }

    next();
  };
}

// ── pre-built param validators ────────────────────────────────────────

/** Validate :id param is a UUID. */
function requireUUIDParam(paramName = 'id') {
  return (req, _res, next) => {
    const val = req.params[paramName];
    if (!isUUID(val)) {
      throw new BadRequestError(`Invalid ${paramName}: must be a valid UUID`);
    }
    next();
  };
}

module.exports = { validate, t, requireUUIDParam, isUUID, sanitize };
