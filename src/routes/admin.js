const express = require('express');
const bcrypt  = require('bcryptjs');
const Joi     = require('joi');
const router  = express.Router();
const db      = require('../../config/database');
const logger  = require('../utils/logger');
const { requireAuth, requireRole, auditLog } = require('../middleware/auth');

// All admin routes require SUPER_ADMIN
router.use(requireAuth);
router.use(requireRole('SUPER_ADMIN'));

const createUserSchema = Joi.object({
  full_name:     Joi.string().min(2).max(150).required(),
  email:         Joi.string().email().required(),
  password:      Joi.string().min(8).required(),
  role:          Joi.string().valid(
    'SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE',
    'CONTRACTOR','FIELD_ENGINEER','READ_ONLY'
  ).required(),
  zone_id:       Joi.number().integer().optional().allow(null),
  contractor_id: Joi.number().integer().optional().allow(null),
});

// ─── GET /api/v1/admin/users ──────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const users = await db.manyOrNone(`
      SELECT u.user_id, u.full_name, u.email, u.role,
             u.is_active, u.last_login, u.created_at,
             z.zone_name, c.company_name
      FROM users u
      LEFT JOIN zones z ON u.zone_id = z.zone_id
      LEFT JOIN contractors c ON u.contractor_id = c.contractor_id
      ORDER BY u.created_at DESC
    `);
    res.json({ ok: true, count: users.length, users });
  } catch (err) {
    logger.error('Get users error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── POST /api/v1/admin/users ─────────────────────────────────────────────────
router.post('/users', async (req, res) => {
  const { error, value } = createUserSchema.validate(req.body);
  if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

  try {
    const existing = await db.oneOrNone(
      'SELECT user_id FROM users WHERE email = $1',
      [value.email.toLowerCase()]
    );
    if (existing) {
      return res.status(409).json({ ok: false, error: 'Email already exists' });
    }

    const hash = await bcrypt.hash(value.password, 10);

    const user = await db.one(`
      INSERT INTO users (full_name, email, password_hash, role, zone_id, contractor_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING user_id, full_name, email, role, zone_id, contractor_id, created_at
    `, [
      value.full_name,
      value.email.toLowerCase(),
      hash,
      value.role,
      value.zone_id || null,
      value.contractor_id || null,
    ]);

    await auditLog(req.user.user_id, 'USER_CREATED', 'users', user.user_id, true, {
      created_email: user.email, role: user.role
    }, req);

    logger.info('User created', { created_by: req.user.user_id, new_user: user.email });
    res.status(201).json({ ok: true, user });
  } catch (err) {
    logger.error('Create user error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── PATCH /api/v1/admin/users/:id ───────────────────────────────────────────
router.patch('/users/:id', async (req, res) => {
  const userId = parseInt(req.params.id);
  const { full_name, role, zone_id, contractor_id, is_active } = req.body;

  try {
    const user = await db.oneOrNone(
      'SELECT user_id FROM users WHERE user_id = $1', [userId]
    );
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });

    await db.none(`
      UPDATE users SET
        full_name     = COALESCE($1, full_name),
        role          = COALESCE($2, role),
        zone_id       = $3,
        contractor_id = $4,
        is_active     = COALESCE($5, is_active)
      WHERE user_id = $6
    `, [full_name, role, zone_id || null, contractor_id || null, is_active, userId]);

    await auditLog(req.user.user_id, 'USER_UPDATED', 'users', userId, true, { role, is_active }, req);
    res.json({ ok: true, message: 'User updated successfully' });
  } catch (err) {
    logger.error('Update user error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── DELETE /api/v1/admin/users/:id (deactivate only) ────────────────────────
router.delete('/users/:id', async (req, res) => {
  const userId = parseInt(req.params.id);
  if (userId === req.user.user_id) {
    return res.status(400).json({ ok: false, error: 'Cannot deactivate your own account' });
  }
  try {
    await db.none('UPDATE users SET is_active = false WHERE user_id = $1', [userId]);
    await auditLog(req.user.user_id, 'USER_DEACTIVATED', 'users', userId, true, {}, req);
    res.json({ ok: true, message: 'User deactivated' });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── POST /api/v1/admin/users/:id/reset-password ─────────────────────────────
router.post('/users/:id/reset-password', async (req, res) => {
  const userId = parseInt(req.params.id);
  const { new_password } = req.body;
  if (!new_password || new_password.length < 8) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
  }
  try {
    const hash = await bcrypt.hash(new_password, 10);
    await db.none('UPDATE users SET password_hash = $1 WHERE user_id = $2', [hash, userId]);
    await auditLog(req.user.user_id, 'PASSWORD_RESET', 'users', userId, true, {}, req);
    res.json({ ok: true, message: 'Password reset successfully' });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── GET /api/v1/admin/audit-log ─────────────────────────────────────────────
router.get('/audit-log', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  try {
    const logs = await db.manyOrNone(`
      SELECT al.*, u.full_name, u.email
      FROM audit_log al
      LEFT JOIN users u ON al.user_id = u.user_id
      ORDER BY al.created_at DESC
      LIMIT $1
    `, [limit]);
    res.json({ ok: true, count: logs.length, logs });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

module.exports = router;