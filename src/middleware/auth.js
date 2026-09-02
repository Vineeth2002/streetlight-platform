const jwt        = require('jsonwebtoken');
const db         = require('../../config/database');
const logger     = require('../utils/logger');

// Fail closed: production/startup requires JWT_SECRET. Never fall back to a
// known development secret because that would allow token forgery if the
// middleware is loaded outside the normal startup path.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is required');
}

// ─── VERIFY JWT TOKEN ────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const user = await db.oneOrNone(
      `SELECT user_id, full_name, email, role, zone_id, contractor_id, is_active
       FROM users WHERE user_id = $1`,
      [decoded.user_id]
    );

    if (!user || !user.is_active) {
      return res.status(401).json({ ok: false, error: 'User not found or inactive' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ ok: false, error: 'Token expired' });
    }
    return res.status(401).json({ ok: false, error: 'Invalid token' });
  }
}

// ─── REQUIRE SPECIFIC ROLES ──────────────────────────────────────────────────
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: 'Not authenticated' });
    }
    if (!roles.includes(req.user.role)) {
      logger.warn('Unauthorized role access attempt', {
        user_id: req.user.user_id,
        role: req.user.role,
        required: roles,
        path: req.path,
      });
      return res.status(403).json({
        ok: false,
        error: `Access denied. Required role: ${roles.join(' or ')}`,
      });
    }
    next();
  };
}

// ─── AUDIT LOGGER ────────────────────────────────────────────────────────────
async function auditLog(userId, action, resource, resourceId, success, details, req) {
  try {
    await db.none(
      `INSERT INTO audit_log
         (user_id, action, resource, resource_id, ip_address, user_agent, success, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        userId || null,
        action,
        resource || null,
        resourceId || null,
        req?.ip || null,
        req?.headers?.['user-agent'] || null,
        success,
        details ? JSON.stringify(details) : null,
      ]
    );
  } catch (err) {
    logger.error('Audit log failed', { error: err.message });
  }
}

// ─── OPTIONAL AUTH (doesn't block if no token) ───────────────────────────────
async function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await db.oneOrNone(
        `SELECT user_id, full_name, email, role, zone_id, contractor_id
         FROM users WHERE user_id = $1 AND is_active = true`,
        [decoded.user_id]
      );
      if (user) req.user = user;
    }
  } catch (_) {
    // silently ignore — optional auth
  }
  next();
}

module.exports = { requireAuth, requireRole, auditLog, optionalAuth };