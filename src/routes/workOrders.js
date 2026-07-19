const express = require('express');
const router  = express.Router();
const Joi     = require('joi');
const db      = require('../../config/database');
const logger  = require('../utils/logger');
const { requireAuth, requireRole, auditLog } = require('../middleware/auth');

// ─── Protect ALL work order routes ───────────────────────────────────────────
router.use(requireAuth);

// ─── Validation schemas ───────────────────────────────────────────────────────
const createSchema = Joi.object({
  pole_id:           Joi.number().integer().required(),
  contractor_id:     Joi.number().integer().optional().allow(null),
  fault_category:    Joi.string().valid(
    'DRIVER_FAULT','LINE_FAULT','DAY_BURNING_FAULT',
    'PREDICTIVE_DEGRADATION','PHYSICAL_DAMAGE',
    'CABLE_THEFT','CABINET_FAULT','MANUAL_REPORT'
  ).required(),
  fault_description: Joi.string().max(1000).optional().allow('', null),
  reported_by:       Joi.string().max(100).optional().allow('', null),
});

const updateSchema = Joi.object({
  ticket_status:      Joi.string().valid(
    'PENDING','ASSIGNED','IN_PROGRESS','RESOLVED','CANCELLED'
  ).optional(),
  resolution_notes:   Joi.string().max(2000).optional().allow('', null),
  resolved_timestamp: Joi.string().isoDate().optional().allow(null),
  assigned_timestamp: Joi.string().isoDate().optional().allow(null),
  contractor_id:      Joi.number().integer().optional().allow(null),
});

// ─── Helper: build role-based WHERE clause ────────────────────────────────────
function buildRoleFilter(user) {
  const conditions = [];
  const params     = [];
  let   paramIndex = 1;

  // Contractor sees only their work orders
  if (user.role === 'CONTRACTOR' && user.contractor_id) {
    conditions.push(`wo.contractor_id = $${paramIndex++}`);
    params.push(user.contractor_id);
  }

  // EE sees only their zone
  if (user.role === 'GVMC_EE' && user.zone_id) {
    conditions.push(`w.zone_id = $${paramIndex++}`);
    params.push(user.zone_id);
  }

  return { conditions, params, nextIndex: paramIndex };
}

// ─── GET /api/v1/work-orders ──────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const status = req.query.status;
    const zoneId = req.query.zone_id;

    const { conditions, params, nextIndex } = buildRoleFilter(req.user);
    let idx = nextIndex;

    if (status) {
      conditions.push(`wo.ticket_status = $${idx++}`);
      params.push(status);
    }
    if (zoneId && req.user.role !== 'GVMC_EE') {
      conditions.push(`w.zone_id = $${idx++}`);
      params.push(parseInt(zoneId));
    }

    const whereClause = conditions.length
      ? 'WHERE ' + conditions.join(' AND ')
      : '';

    params.push(limit, offset);

    const rows = await db.manyOrNone(`
      SELECT wo.work_order_id, wo.pole_id, wo.contractor_id,
             wo.fault_category, wo.fault_description,
             wo.reported_by, wo.reported_timestamp,
             wo.assigned_timestamp, wo.resolved_timestamp,
             wo.sla_deadline, wo.ticket_status,
             wo.resolution_notes, wo.penalty_deducted,
             wo.penalty_type, wo.days_overdue,
             p.pole_number, p.luminaire_wattage, p.wiring_type,
             c.company_name AS contractor_name,
             z.zone_name,
             w.ward_number
      FROM work_orders wo
      JOIN poles p ON wo.pole_id = p.pole_id
      JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id
      JOIN wards w ON jb.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      LEFT JOIN contractors c ON wo.contractor_id = c.contractor_id
      ${whereClause}
      ORDER BY wo.reported_timestamp DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, params);

    res.json({ ok: true, count: rows.length, data: rows });
  } catch (err) {
    logger.error('Get work orders error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── GET /api/v1/work-orders/sla-breaches ────────────────────────────────────
router.get('/sla-breaches', async (req, res) => {
  try {
    const { conditions, params, nextIndex } = buildRoleFilter(req.user);
    let idx = nextIndex;
    conditions.push(`wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS')`);
    conditions.push(`NOW() > wo.sla_deadline`);
    params.push(50);

    const rows = await db.manyOrNone(`
      SELECT wo.work_order_id, wo.pole_id, wo.fault_category,
             wo.reported_timestamp, wo.sla_deadline,
             wo.ticket_status, wo.days_overdue,
             p.pole_number,
             z.zone_name, w.ward_number,
             c.company_name AS contractor_name,
             EXTRACT(EPOCH FROM (NOW() - wo.sla_deadline))/3600.0 AS hours_overdue
      FROM work_orders wo
      JOIN poles p ON wo.pole_id = p.pole_id
      JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id
      JOIN wards w ON jb.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      LEFT JOIN contractors c ON wo.contractor_id = c.contractor_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY wo.sla_deadline ASC
      LIMIT $${idx}
    `, params);

    res.json({ ok: true, count: rows.length, breaches: rows });
  } catch (err) {
    logger.error('SLA breaches error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── GET /api/v1/work-orders/:id ─────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const wo = await db.oneOrNone(`
      SELECT wo.*, p.pole_number, p.luminaire_wattage, p.wiring_type,
             c.company_name AS contractor_name,
             z.zone_name, w.ward_number
      FROM work_orders wo
      JOIN poles p ON wo.pole_id = p.pole_id
      JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id
      JOIN wards w ON jb.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      LEFT JOIN contractors c ON wo.contractor_id = c.contractor_id
      WHERE wo.work_order_id = $1
    `, [parseInt(req.params.id)]);

    if (!wo) return res.status(404).json({ ok: false, error: 'Work order not found' });

    // Contractor can only see their own
    if (req.user.role === 'CONTRACTOR' &&
        wo.contractor_id !== req.user.contractor_id) {
      return res.status(403).json({ ok: false, error: 'Access denied' });
    }

    res.json({ ok: true, data: wo });
  } catch (err) {
    logger.error('Get work order error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── POST /api/v1/work-orders ─────────────────────────────────────────────────
router.post('/',
  requireRole('SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE'),
  async (req, res) => {
    const { error, value } = createSchema.validate(req.body);
    if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

    try {
      const pole = await db.oneOrNone(
        'SELECT pole_id FROM poles WHERE pole_id = $1', [value.pole_id]
      );
      if (!pole) return res.status(404).json({ ok: false, error: 'Pole not found' });

      // Check for existing open ticket on same pole + fault
      const existing = await db.oneOrNone(`
        SELECT work_order_id FROM work_orders
        WHERE pole_id = $1 AND fault_category = $2
          AND ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED')
        LIMIT 1
      `, [value.pole_id, value.fault_category]);

      if (existing) {
        return res.status(409).json({
          ok: false,
          error: 'Open ticket already exists for this pole and fault type',
          existing_work_order_id: existing.work_order_id,
        });
      }

      const wo = await db.one(`
        INSERT INTO work_orders
          (pole_id, contractor_id, fault_category, fault_description,
           reported_by, reported_timestamp)
        VALUES ($1, $2, $3, $4, $5, NOW())
        RETURNING *
      `, [
        value.pole_id,
        value.contractor_id || null,
        value.fault_category,
        value.fault_description || null,
        value.reported_by || req.user.full_name,
      ]);

      await auditLog(req.user.user_id, 'WORK_ORDER_CREATED', 'work_orders',
        wo.work_order_id, true, { fault_category: value.fault_category }, req);

      logger.info('Work order created', {
        work_order_id: wo.work_order_id,
        by: req.user.user_id
      });

      res.status(201).json({ ok: true, data: wo });
    } catch (err) {
      logger.error('Create work order error', { error: err.message });
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  }
);

// ─── PATCH /api/v1/work-orders/:id ───────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  const { error, value } = updateSchema.validate(req.body);
  if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

  try {
    const wo = await db.oneOrNone(
      'SELECT * FROM work_orders WHERE work_order_id = $1',
      [parseInt(req.params.id)]
    );
    if (!wo) return res.status(404).json({ ok: false, error: 'Work order not found' });

    // Contractor can only update their own
    if (req.user.role === 'CONTRACTOR' &&
        wo.contractor_id !== req.user.contractor_id) {
      return res.status(403).json({ ok: false, error: 'Access denied' });
    }

    // Field engineer can only mark IN_PROGRESS or RESOLVED
    if (req.user.role === 'FIELD_ENGINEER') {
      const allowed = ['IN_PROGRESS', 'RESOLVED'];
      if (value.ticket_status && !allowed.includes(value.ticket_status)) {
        return res.status(403).json({
          ok: false,
          error: 'Field engineers can only set IN_PROGRESS or RESOLVED'
        });
      }
    }

    // Build update
    const updates = [];
    const params  = [];
    let   idx     = 1;

    if (value.ticket_status) {
      updates.push(`ticket_status = $${idx++}`);
      params.push(value.ticket_status);
    }
    if (value.resolution_notes !== undefined) {
      updates.push(`resolution_notes = $${idx++}`);
      params.push(value.resolution_notes);
    }
    if (value.resolved_timestamp) {
      updates.push(`resolved_timestamp = $${idx++}`);
      params.push(value.resolved_timestamp);
    }
    if (value.assigned_timestamp) {
      updates.push(`assigned_timestamp = $${idx++}`);
      params.push(value.assigned_timestamp);
    }
    if (value.contractor_id !== undefined) {
      updates.push(`contractor_id = $${idx++}`);
      params.push(value.contractor_id);
    }

    if (!updates.length) {
      return res.status(400).json({ ok: false, error: 'No fields to update' });
    }

    params.push(parseInt(req.params.id));
    await db.none(
      `UPDATE work_orders SET ${updates.join(', ')} WHERE work_order_id = $${idx}`,
      params
    );

    await auditLog(req.user.user_id, 'WORK_ORDER_UPDATED', 'work_orders',
      parseInt(req.params.id), true, { changes: value }, req);

    res.json({ ok: true, message: 'Work order updated' });
  } catch (err) {
    logger.error('Update work order error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

module.exports = router;
