const express   = require('express');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const crypto    = require('crypto');
const Joi       = require('joi');
const router    = express.Router();
const db        = require('../../config/database');
const logger    = require('../utils/logger');
const { auditLog, requireAuth } = require('../middleware/auth');

const JWT_SECRET           = process.env.JWT_SECRET  || 'change_this_in_production';
const JWT_EXPIRES_IN       = process.env.JWT_EXPIRES  || '8h';
const REFRESH_EXPIRES_DAYS = 30;
const MAX_LOGIN_ATTEMPTS   = 5;
const LOCKOUT_MINUTES      = 15;

// ─── In-memory brute force tracker ───────────────────────────────────────────
// For production use Redis instead
const loginAttempts = new Map();

function getAttemptKey(email, ip) {
  return `${email}:${ip}`;
}

function checkBruteForce(email, ip) {
  const key  = getAttemptKey(email, ip);
  const data = loginAttempts.get(key);
  if (!data) return { blocked: false };

  const now     = Date.now();
  const elapsed = (now - data.firstAttempt) / 60000; // minutes

  // Reset after lockout period
  if (elapsed > LOCKOUT_MINUTES) {
    loginAttempts.delete(key);
    return { blocked: false };
  }

  if (data.count >= MAX_LOGIN_ATTEMPTS) {
    const remaining = Math.ceil(LOCKOUT_MINUTES - elapsed);
    return { blocked: true, remaining };
  }

  return { blocked: false };
}

function recordFailedAttempt(email, ip) {
  const key  = getAttemptKey(email, ip);
  const data = loginAttempts.get(key);
  if (!data) {
    loginAttempts.set(key, { count: 1, firstAttempt: Date.now() });
  } else {
    data.count++;
    loginAttempts.set(key, data);
  }
}

function clearAttempts(email, ip) {
  loginAttempts.delete(getAttemptKey(email, ip));
}

// ─── Validation schemas ───────────────────────────────────────────────────────
const loginSchema = Joi.object({
  email:    Joi.string().email().required(),
  password: Joi.string().min(6).max(100).required(),
});

const changePasswordSchema = Joi.object({
  current_password: Joi.string().required(),
  new_password:     Joi.string().min(8).max(100).required(),
});

// ─── POST /api/v1/auth/login ──────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { error, value } = loginSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ ok: false, error: error.details[0].message });
  }

  const { email, password } = value;
  const ip = req.ip || req.connection.remoteAddress;

  // ── Brute force check ──
  const bruteCheck = checkBruteForce(email, ip);
  if (bruteCheck.blocked) {
    logger.warn('Login blocked — too many attempts', { email, ip });
    return res.status(429).json({
      ok: false,
      error: `Too many failed attempts. Try again in ${bruteCheck.remaining} minutes.`,
    });
  }

  try {
    const user = await db.oneOrNone(
      `SELECT user_id, full_name, email, password_hash, role,
              zone_id, contractor_id, is_active
       FROM users WHERE email = $1`,
      [email.toLowerCase()]
    );

    // Same error for wrong email AND wrong password (security)
    if (!user) {
      recordFailedAttempt(email, ip);
      await auditLog(null, 'LOGIN_FAILED', 'users', null, false, { email }, req);
      return res.status(401).json({ ok: false, error: 'Invalid email or password' });
    }

    if (!user.is_active) {
      await auditLog(user.user_id, 'LOGIN_BLOCKED', 'users', user.user_id, false, {}, req);
      return res.status(403).json({ ok: false, error: 'Account is deactivated. Contact IT Helpdesk.' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      recordFailedAttempt(email, ip);
      await auditLog(user.user_id, 'LOGIN_FAILED', 'users', user.user_id, false, {}, req);
      return res.status(401).json({ ok: false, error: 'Invalid email or password' });
    }

    // ── Successful login — clear attempts ──
    clearAttempts(email, ip);

    // Generate JWT
    const token = jwt.sign(
      { user_id: user.user_id, role: user.role, email: user.email },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    // Generate refresh token
    const refreshToken = crypto.randomBytes(64).toString('hex');
    const refreshHash  = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const refreshExpiry = new Date();
    refreshExpiry.setDate(refreshExpiry.getDate() + REFRESH_EXPIRES_DAYS);

    await db.none(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [user.user_id, refreshHash, refreshExpiry]
    );

    // Update last login
    await db.none(
      `UPDATE users SET last_login = NOW() WHERE user_id = $1`,
      [user.user_id]
    );

    await auditLog(user.user_id, 'LOGIN_SUCCESS', 'users', user.user_id, true, {
      ip, role: user.role
    }, req);

    logger.info('User logged in', { user_id: user.user_id, role: user.role, ip });

    res.json({
      ok:            true,
      token,
      refresh_token: refreshToken,
      expires_in:    JWT_EXPIRES_IN,
      user: {
        user_id:       user.user_id,
        full_name:     user.full_name,
        email:         user.email,
        role:          user.role,
        zone_id:       user.zone_id,
        contractor_id: user.contractor_id,
      },
    });
  } catch (err) {
    logger.error('Login error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── POST /api/v1/auth/refresh ────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) {
    return res.status(400).json({ ok: false, error: 'Refresh token required' });
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(refresh_token).digest('hex');

    const stored = await db.oneOrNone(
      `SELECT rt.token_id, rt.user_id, rt.expires_at,
              u.email, u.role, u.is_active, u.full_name,
              u.zone_id, u.contractor_id
       FROM refresh_tokens rt
       JOIN users u ON rt.user_id = u.user_id
       WHERE rt.token_hash = $1`,
      [tokenHash]
    );

    if (!stored || !stored.is_active) {
      return res.status(401).json({ ok: false, error: 'Invalid refresh token' });
    }

    if (new Date() > new Date(stored.expires_at)) {
      await db.none(`DELETE FROM refresh_tokens WHERE token_id = $1`, [stored.token_id]);
      return res.status(401).json({ ok: false, error: 'Refresh token expired. Please login again.' });
    }

    const token = jwt.sign(
      { user_id: stored.user_id, role: stored.role, email: stored.email },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({ ok: true, token, expires_in: JWT_EXPIRES_IN });
  } catch (err) {
    logger.error('Refresh error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── POST /api/v1/auth/logout ─────────────────────────────────────────────────
router.post('/logout', requireAuth, async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (refresh_token) {
      const tokenHash = crypto.createHash('sha256').update(refresh_token).digest('hex');
      await db.none(`DELETE FROM refresh_tokens WHERE token_hash = $1`, [tokenHash]);
    }

    await auditLog(req.user.user_id, 'LOGOUT', 'users', req.user.user_id, true, {}, req);
    logger.info('User logged out', { user_id: req.user.user_id });

    res.json({ ok: true, message: 'Logged out successfully' });
  } catch (err) {
    logger.error('Logout error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── GET /api/v1/auth/me ──────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await db.oneOrNone(
      `SELECT u.user_id, u.full_name, u.email, u.role,
              u.zone_id, u.contractor_id, u.last_login, u.created_at,
              z.zone_name, c.company_name
       FROM users u
       LEFT JOIN zones z ON u.zone_id = z.zone_id
       LEFT JOIN contractors c ON u.contractor_id = c.contractor_id
       WHERE u.user_id = $1`,
      [req.user.user_id]
    );

    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });

    res.json({ ok: true, user });
  } catch (err) {
    logger.error('Get me error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── POST /api/v1/auth/change-password ───────────────────────────────────────
router.post('/change-password', requireAuth, async (req, res) => {
  const { error, value } = changePasswordSchema.validate(req.body);
  if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

  try {
    const user = await db.one(
      `SELECT password_hash FROM users WHERE user_id = $1`,
      [req.user.user_id]
    );

    const match = await bcrypt.compare(value.current_password, user.password_hash);
    if (!match) {
      return res.status(400).json({ ok: false, error: 'Current password is incorrect' });
    }

    // Prevent reusing same password
    const samePassword = await bcrypt.compare(value.new_password, user.password_hash);
    if (samePassword) {
      return res.status(400).json({
        ok: false, error: 'New password must be different from current password'
      });
    }

    const newHash = await bcrypt.hash(value.new_password, 10);

    await db.none(
      `UPDATE users SET password_hash = $1 WHERE user_id = $2`,
      [newHash, req.user.user_id]
    );

    // ── Invalidate ALL refresh tokens on password change ──
    await db.none(
      `DELETE FROM refresh_tokens WHERE user_id = $1`,
      [req.user.user_id]
    );

    await auditLog(req.user.user_id, 'PASSWORD_CHANGED', 'users',
      req.user.user_id, true, {}, req);

    logger.info('Password changed', { user_id: req.user.user_id });

    res.json({
      ok: true,
      message: 'Password changed successfully. Please login again.'
    });
  } catch (err) {
    logger.error('Change password error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── POST /api/v1/auth/logout-all ────────────────────────────────────────────
// Logout from all devices
router.post('/logout-all', requireAuth, async (req, res) => {
  try {
    await db.none(
      `DELETE FROM refresh_tokens WHERE user_id = $1`,
      [req.user.user_id]
    );

    await auditLog(req.user.user_id, 'LOGOUT_ALL_DEVICES', 'users',
      req.user.user_id, true, {}, req);

    res.json({ ok: true, message: 'Logged out from all devices' });
  } catch (err) {
    logger.error('Logout all error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

module.exports = router;