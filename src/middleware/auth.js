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

// ─── POLE ZONE AUTHORIZATION ────────────────────────────────────────────────
// GVMC_EE is zone-scoped. Keep this boundary in shared auth middleware so a
// future route cannot accidentally bypass the scope check.
async function enforcePoleScope(req, res) {
  if (req.user.role !== 'GVMC_EE' || req.baseUrl !== '/api/v1/poles') return true;

  if (!req.user.zone_id) {
    logger.warn('GVMC_EE denied because no zone is assigned', {
      user_id: req.user.user_id,
      path: req.path,
    });
    res.status(403).json({ ok: false, error: 'Access denied: user has no assigned zone' });
    return false;
  }

  // Search has no route-level scope predicate. Deny it for EEs rather than
  // risk exposing another zone's pole data.
  if (req.method === 'GET' && req.path.startsWith('/search/')) {
    logger.warn('GVMC_EE denied unscoped pole search', {
      user_id: req.user.user_id,
      zone_id: req.user.zone_id,
    });
    res.status(403).json({ ok: false, error: 'Access denied: use zone-scoped pole listing' });
    return false;
  }

  // PATCH /:id must be scoped to the EE's zone before the route can mutate it.
  if (req.method === 'PATCH' && /^\/\d+$/.test(req.path)) {
    const pole = await db.oneOrNone(
      `SELECT p.pole_id
       FROM poles p
       JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id
       JOIN wards w ON jb.ward_id = w.ward_id
       WHERE p.pole_id = $1 AND w.zone_id = $2`,
      [parseInt(req.params.id, 10), req.user.zone_id]
    );
    if (!pole) {
      logger.warn('GVMC_EE denied cross-zone pole mutation', {
        user_id: req.user.user_id,
        zone_id: req.user.zone_id,
        pole_id: req.params.id,
      });
      res.status(403).json({ ok: false, error: 'Access denied' });
      return false;
    }
  }

  // POST / must only allow creation under a cabinet in the EE's zone.
  if (req.method === 'POST' && req.path === '/') {
    const cabinetId = Number(req.body?.cabinet_id);
    if (!Number.isInteger(cabinetId)) {
      res.status(400).json({ ok: false, error: 'Invalid cabinet_id' });
      return false;
    }
    const cabinet = await db.oneOrNone(
      `SELECT jb.cabinet_id
       FROM junction_boxes jb
       JOIN wards w ON jb.ward_id = w.ward_id
       WHERE jb.cabinet_id = $1 AND w.zone_id = $2`,
      [cabinetId, req.user.zone_id]
    );
    if (!cabinet) {
      logger.warn('GVMC_EE denied cross-zone pole creation', {
        user_id: req.user.user_id,
        zone_id: req.user.zone_id,
        cabinet_id: cabinetId,
      });
      res.status(403).json({ ok: false, error: 'Access denied' });
      return false;
    }
  }

  return true;
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
    if (!(await enforcePoleScope(req, res))) return;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ ok: false, error: 'Token expired' });
    }
    logger.error('Authentication/scope check failed', { error: err.message, path: req.path });
    return res.status(401).json({ ok: false, error: 'Invalid token' });
  }
}

// ─── REQUIRE SPECIFIC ROLES ──────────────────────────────────────────────────
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Not authenticated' });
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
      [userId || null, action, resource || null, resourceId || null,
       req?.ip || null, req?.headers?.['user-agent'] || null, success,
       details ? JSON.stringify(details) : null]
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
  } catch (_) {}
  next();
}

module.exports = { requireAuth, requireRole, auditLog, optionalAuth };