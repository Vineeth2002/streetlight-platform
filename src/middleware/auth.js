const jwt        = require('jsonwebtoken');
const db         = require('../../config/database');
const logger     = require('../utils/logger');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET is required');

async function enforcePoleScope(req, res) {
  if (req.user.role !== 'GVMC_EE' || req.baseUrl !== '/api/v1/poles') return true;
  if (!req.user.zone_id) {
    logger.warn('GVMC_EE denied because no zone is assigned', { user_id: req.user.user_id, path: req.path });
    res.status(403).json({ ok: false, error: 'Access denied: user has no assigned zone' });
    return false;
  }
  if (req.method === 'GET' && req.path.startsWith('/search/')) {
    logger.warn('GVMC_EE denied unscoped pole search', { user_id: req.user.user_id, zone_id: req.user.zone_id });
    res.status(403).json({ ok: false, error: 'Access denied: use zone-scoped pole listing' });
    return false;
  }
  if (req.method === 'PATCH' && /^\/\d+$/.test(req.path)) {
    const pole = await db.oneOrNone(`SELECT p.pole_id FROM poles p JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id JOIN wards w ON jb.ward_id = w.ward_id WHERE p.pole_id = $1 AND w.zone_id = $2`, [parseInt(req.params.id, 10), req.user.zone_id]);
    if (!pole) {
      logger.warn('GVMC_EE denied cross-zone pole mutation', { user_id: req.user.user_id, zone_id: req.user.zone_id, pole_id: req.params.id });
      res.status(403).json({ ok: false, error: 'Access denied' });
      return false;
    }
  }
  if (req.method === 'POST' && req.path === '/') {
    const cabinetId = Number(req.body?.cabinet_id);
    if (!Number.isInteger(cabinetId)) {
      res.status(400).json({ ok: false, error: 'Invalid cabinet_id' });
      return false;
    }
    const cabinet = await db.oneOrNone(`SELECT jb.cabinet_id FROM junction_boxes jb JOIN wards w ON jb.ward_id = w.ward_id WHERE jb.cabinet_id = $1 AND w.zone_id = $2`, [cabinetId, req.user.zone_id]);
    if (!cabinet) {
      logger.warn('GVMC_EE denied cross-zone pole creation', { user_id: req.user.user_id, zone_id: req.user.zone_id, cabinet_id: cabinetId });
      res.status(403).json({ ok: false, error: 'Access denied' });
      return false;
    }
  }
  return true;
}

async function enforceWorkOrderScope(req, res) {
  if (req.baseUrl !== '/api/v1/work-orders') return true;
  const scopedRoles = ['CONTRACTOR', 'GVMC_EE', 'FIELD_ENGINEER'];
  if (!scopedRoles.includes(req.user.role)) return true;

  if (req.user.role === 'CONTRACTOR' && !req.user.contractor_id) {
    res.status(403).json({ ok: false, error: 'Access denied: user has no assigned contractor' });
    return false;
  }
  if (req.user.role === 'GVMC_EE' && !req.user.zone_id) {
    res.status(403).json({ ok: false, error: 'Access denied: user has no assigned zone' });
    return false;
  }

  const idMatch = req.path.match(/^\/(\d+)(?:\/|$)/);
  if (idMatch) {
    const workOrderId = Number.parseInt(idMatch[1], 10);
    const workOrder = await db.oneOrNone(`
      SELECT wo.work_order_id, wo.contractor_id, wo.assigned_to, w.zone_id
      FROM work_orders wo
      JOIN poles p ON wo.pole_id = p.pole_id
      JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id
      JOIN wards w ON jb.ward_id = w.ward_id
      WHERE wo.work_order_id = $1`, [workOrderId]);
    if (!workOrder) {
      res.status(404).json({ ok: false, error: 'Work order not found' });
      return false;
    }
    const allowed =
      (req.user.role === 'CONTRACTOR' && workOrder.contractor_id === req.user.contractor_id) ||
      (req.user.role === 'GVMC_EE' && workOrder.zone_id === req.user.zone_id) ||
      (req.user.role === 'FIELD_ENGINEER' && workOrder.assigned_to === req.user.user_id);
    if (!allowed) {
      logger.warn('Work-order scope denied', { user_id: req.user.user_id, role: req.user.role, work_order_id: workOrderId });
      res.status(403).json({ ok: false, error: 'Access denied' });
      return false;
    }
  }
  return true;
}

async function enforceAttachmentScope(req, res) {
  if (req.baseUrl !== '/api/v1/attachments' || req.user.role !== 'GVMC_EE') return true;
  if (!req.user.zone_id) {
    logger.warn('GVMC_EE denied attachment access because no zone is assigned', { user_id: req.user.user_id, path: req.path });
    res.status(403).json({ ok: false, error: 'Access denied: user has no assigned zone' });
    return false;
  }

  const idMatch = req.path.match(/^\/(?:pole\/)?(\d+)(?:\/|$)/);
  if ((req.method === 'GET' || req.method === 'PATCH') && idMatch) {
    const attachmentIdOrPoleId = Number.parseInt(idMatch[1], 10);
    const lookup = req.path.startsWith('/pole/')
      ? `SELECT a.attachment_id FROM smart_city_attachments a JOIN poles p ON a.pole_id = p.pole_id JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id JOIN wards w ON jb.ward_id = w.ward_id WHERE a.pole_id = $1 AND w.zone_id = $2 LIMIT 1`
      : `SELECT a.attachment_id FROM smart_city_attachments a JOIN poles p ON a.pole_id = p.pole_id JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id JOIN wards w ON jb.ward_id = w.ward_id WHERE a.attachment_id = $1 AND w.zone_id = $2`;
    const row = await db.oneOrNone(lookup, [attachmentIdOrPoleId, req.user.zone_id]);
    if (!row) {
      logger.warn('GVMC_EE denied cross-zone attachment access', { user_id: req.user.user_id, zone_id: req.user.zone_id, path: req.path });
      res.status(403).json({ ok: false, error: 'Access denied' });
      return false;
    }
  }

  if (req.method === 'POST' && req.path === '/') {
    const poleId = Number(req.body?.pole_id);
    if (!Number.isInteger(poleId)) {
      res.status(400).json({ ok: false, error: 'Invalid pole_id' });
      return false;
    }
    const pole = await db.oneOrNone(`SELECT p.pole_id FROM poles p JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id JOIN wards w ON jb.ward_id = w.ward_id WHERE p.pole_id = $1 AND w.zone_id = $2`, [poleId, req.user.zone_id]);
    if (!pole) {
      logger.warn('GVMC_EE denied cross-zone attachment creation', { user_id: req.user.user_id, zone_id: req.user.zone_id, pole_id: poleId });
      res.status(403).json({ ok: false, error: 'Access denied' });
      return false;
    }
  }
  return true;
}

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ ok: false, error: 'No token provided' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await db.oneOrNone(`SELECT user_id, full_name, email, role, zone_id, contractor_id, is_active FROM users WHERE user_id = $1`, [decoded.user_id]);
    if (!user || !user.is_active) return res.status(401).json({ ok: false, error: 'User not found or inactive' });
    req.user = user;
    if (!(await enforcePoleScope(req, res))) return;
    if (!(await enforceWorkOrderScope(req, res))) return;
    if (!(await enforceAttachmentScope(req, res))) return;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ ok: false, error: 'Token expired' });
    logger.error('Authentication/scope check failed', { error: err.message, path: req.path });
    return res.status(401).json({ ok: false, error: 'Invalid token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) {
      logger.warn('Unauthorized role access attempt', { user_id: req.user.user_id, role: req.user.role, required: roles, path: req.path });
      return res.status(403).json({ ok: false, error: `Access denied. Required role: ${roles.join(' or ')}` });
    }
    next();
  };
}

async function auditLog(userId, action, resource, resourceId, success, details, req) {
  try {
    await db.none(`INSERT INTO audit_log (user_id, action, resource, resource_id, ip_address, user_agent, success, details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [userId || null, action, resource || null, resourceId || null, req?.ip || null, req?.headers?.['user-agent'] || null, success, details ? JSON.stringify(details) : null]);
  } catch (err) {
    logger.error('Audit log failed', { error: err.message });
  }
}

async function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await db.oneOrNone(`SELECT user_id, full_name, email, role, zone_id, contractor_id FROM users WHERE user_id = $1 AND is_active = true`, [decoded.user_id]);
      if (user) req.user = user;
    }
  } catch (_) {}
  next();
}

module.exports = { requireAuth, requireRole, auditLog, optionalAuth };