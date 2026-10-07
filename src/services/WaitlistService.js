/**
 * Waitlist Service
 *
 * Manages the alpha-testing waitlist flow:
 *   addToWaitlist  — validate, hash password, insert into waitlist table
 *   listWaitlist   — return all entries (admin)
 *   approve        — create real user account + send welcome email
 *   reject         — mark rejected + send rejection email
 */

const bcrypt = require('bcrypt');
const { queryOne, queryAll } = require('../config/database');
const { generateApiKey, hashToken } = require('../utils/auth');
const { BadRequestError, ConflictError, NotFoundError } = require('../utils/errors');
const EmailService = require('./EmailService');

class WaitlistService {
  /**
   * Add a new sign-up request to the waitlist.
   * Returns the created waitlist entry (without password_hash).
   */
  static async addToWaitlist({ username, email, password, displayName = '' }) {
    const normalizedUsername = username.toLowerCase().trim();
    const normalizedEmail    = email.toLowerCase().trim();

    // Basic validation
    if (!/^[a-z0-9_]+$/i.test(normalizedUsername)) {
      throw new BadRequestError('Username can only contain letters, numbers, and underscores');
    }
    if (normalizedUsername.length < 3 || normalizedUsername.length > 32) {
      throw new BadRequestError('Username must be 3–32 characters');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new BadRequestError('Invalid email format');
    }
    if (!password || password.length < 6) {
      throw new BadRequestError('Password must be at least 6 characters');
    }

    // Reject if already on waitlist (any status)
    const existingWaitlist = await queryOne(
      'SELECT id, status FROM waitlist WHERE email = $1',
      [normalizedEmail]
    );
    if (existingWaitlist) {
      if (existingWaitlist.status === 'pending') {
        throw new ConflictError(
          'Email already on waitlist',
          'You are already on the waitlist. We will be in touch soon.'
        );
      }
      if (existingWaitlist.status === 'rejected') {
        throw new ConflictError(
          'Application previously declined',
          'Your previous application was not accepted. Please contact support if you believe this is an error.'
        );
      }
      // approved — point them to login
      throw new ConflictError(
        'Account already active',
        'Your account has already been approved. Please sign in.'
      );
    }

    // Reject if username/email already exists as a real user
    const existingUser = await queryOne(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [normalizedUsername, normalizedEmail]
    );
    if (existingUser) {
      throw new ConflictError(
        'Username or email already registered',
        'Try a different username or email, or sign in.'
      );
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const effectiveDisplayName = displayName.trim() || normalizedUsername;

    const entry = await queryOne(
      `INSERT INTO waitlist (username, email, password_hash, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, email, display_name, status, created_at`,
      [normalizedUsername, normalizedEmail, passwordHash, effectiveDisplayName]
    );

    // Fire-and-forget confirmation email
    EmailService.sendWaitlistConfirmation(normalizedEmail, effectiveDisplayName).catch((err) =>
      console.error('[WaitlistService] Failed to send confirmation email:', err.message)
    );

    return entry;
  }

  /**
   * Return all waitlist entries, most recent first.
   * Admin use only.
   */
  static async listWaitlist({ status } = {}) {
    const where = status ? `WHERE status = $1` : '';
    const params = status ? [status] : [];
    return queryAll(
      `SELECT id, username, email, display_name, status, notes, created_at, reviewed_at
       FROM waitlist ${where}
       ORDER BY created_at DESC`,
      params
    );
  }

  /**
   * Approve a waitlist entry: create a real user account, then send welcome email.
   */
  static async approve(waitlistId) {
    const entry = await queryOne(
      'SELECT * FROM waitlist WHERE id = $1',
      [waitlistId]
    );
    if (!entry) throw new NotFoundError('Waitlist entry not found');
    if (entry.status === 'approved') {
      throw new BadRequestError('Entry already approved');
    }
    if (entry.status === 'rejected') {
      throw new BadRequestError('Cannot approve a rejected entry');
    }

    // Check if a user account was already created (e.g. double-call)
    const existingUser = await queryOne(
      'SELECT id FROM users WHERE email = $1',
      [entry.email]
    );
    if (existingUser) {
      // Just mark as approved in waitlist and return
      await queryOne(
        `UPDATE waitlist SET status = 'approved', reviewed_at = NOW() WHERE id = $1`,
        [waitlistId]
      );
      return existingUser;
    }

    // Generate API key for the new account
    const apiKey     = generateApiKey();
    const apiKeyHash = hashToken(apiKey);

    const newUser = await queryOne(
      `INSERT INTO users (username, email, display_name, password_hash, api_key_hash, is_active, is_verified)
       VALUES ($1, $2, $3, $4, $5, TRUE, TRUE)
       RETURNING id, username, email, display_name`,
      [entry.username, entry.email, entry.display_name, entry.password_hash, apiKeyHash]
    );

    // Mark waitlist entry as approved
    await queryOne(
      `UPDATE waitlist SET status = 'approved', reviewed_at = NOW() WHERE id = $1`,
      [waitlistId]
    );

    // Send welcome email (fire-and-forget)
    EmailService.sendWaitlistApproved(entry.email, entry.display_name).catch((err) =>
      console.error('[WaitlistService] Failed to send approval email:', err.message)
    );

    return newUser;
  }

  /**
   * Reject a waitlist entry and send a polite decline email.
   */
  static async reject(waitlistId, { notes } = {}) {
    const entry = await queryOne(
      'SELECT * FROM waitlist WHERE id = $1',
      [waitlistId]
    );
    if (!entry) throw new NotFoundError('Waitlist entry not found');
    if (entry.status === 'rejected') {
      throw new BadRequestError('Entry already rejected');
    }
    if (entry.status === 'approved') {
      throw new BadRequestError('Cannot reject an already approved entry');
    }

    await queryOne(
      `UPDATE waitlist
       SET status = 'rejected', reviewed_at = NOW(), notes = COALESCE($2, notes)
       WHERE id = $1`,
      [waitlistId, notes || null]
    );

    // Send decline email (fire-and-forget)
    EmailService.sendWaitlistRejected(entry.email, entry.display_name).catch((err) =>
      console.error('[WaitlistService] Failed to send rejection email:', err.message)
    );

    return { id: waitlistId, status: 'rejected' };
  }

  /**
   * Get the waitlist status for an email address.
   * Returns 'pending' | 'approved' | 'rejected' | 'not_found'.
   * Used to gate OAuth logins.
   */
  static async getStatusByEmail(email) {
    const normalizedEmail = email.toLowerCase().trim();
    const entry = await queryOne(
      'SELECT status FROM waitlist WHERE email = $1',
      [normalizedEmail]
    );
    return entry ? entry.status : 'not_found';
  }

  /**
   * Add an OAuth user (Google/Microsoft) to the waitlist without a password.
   * The user has already authenticated via OAuth — we just need to record their
   * interest and hold them until an admin approves.
   *
   * Returns the waitlist status: 'pending' | 'approved' | 'rejected'
   */
  static async addOAuthUserToWaitlist(email, displayName = '') {
    const normalizedEmail = email.toLowerCase().trim();

    // If already on the waitlist, just return the existing status.
    const existing = await queryOne(
      'SELECT status FROM waitlist WHERE email = $1',
      [normalizedEmail]
    );
    if (existing) {
      return existing.status;
    }

    // Derive a safe username from the email local-part.
    const rawUsername = normalizedEmail.split('@')[0].replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    // Ensure uniqueness — append random suffix if the username is taken.
    let username = rawUsername.slice(0, 28);
    const taken = await queryOne(
      'SELECT id FROM waitlist WHERE username = $1',
      [username]
    );
    if (taken) {
      username = `${username.slice(0, 24)}_${Math.floor(Math.random() * 9999)}`;
    }

    const effectiveDisplayName = displayName.trim() || username;
    // Use a random unhashable placeholder — OAuth users never log in with a password.
    const crypto = require('crypto');
    const passwordPlaceholder = `oauth:${crypto.randomBytes(32).toString('hex')}`;

    await queryOne(
      `INSERT INTO waitlist (username, email, password_hash, display_name)
       VALUES ($1, $2, $3, $4)`,
      [username, normalizedEmail, passwordPlaceholder, effectiveDisplayName]
    );

    // Fire-and-forget confirmation email
    EmailService.sendWaitlistConfirmation(normalizedEmail, effectiveDisplayName).catch((err) =>
      console.error('[WaitlistService] Failed to send OAuth waitlist confirmation email:', err.message)
    );

    return 'pending';
  }
}

module.exports = WaitlistService;
