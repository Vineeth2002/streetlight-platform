const express = require('express');
const router  = express.Router();
const Joi     = require('joi');
const db      = require('../../config/database');
const logger  = require('../utils/logger');
const { requireAuth, requireRole, auditLog } = require('../middleware/auth');

router.use(requireAuth);

const createSchema = Joi.object({
  pole_id: Joi.number().integer().required(),
  contractor_id: Joi.number().integer().optional().allow(null),
  fault_category: Joi.string().valid('DRIVER_FAULT','LINE_FAULT','DAY_BURNING_FAULT','PREDICTIVE_DEGRADATION','PHYSICAL_DAMAGE','CABLE_THEFT','CABINET_FAULT','MANUAL_REPORT').required(),
  fault_description: Joi.string().max(1000).optional().allow('', null),
  reported_by: Joi.string().max(100).optional().allow('', null),
});

const updateSchema = Joi.object({
  resolution_notes: Joi.string().max(2000).optional().allow('', null),
  resolved_timestamp: Joi.string().isoDate().optional().allow(null),
}).min(1);

function buildRoleFilter(user) {
  const conditions = [];
  const params = [];
  let paramIndex = 1;

  if (user.role === 'CONTRACTOR' && user.contractor_id) {
    conditions.push(`wo.contractor_id = $${paramIndex++}`);
    params.push(user.contractor_id);
  }
  if (user.role === 'GVMC_EE' && user.zone_id) {
    conditions.push(`w.zone_id = $${paramIndex++}`);
    params.push(user.zone_id);
  }
  if (user.role === 'FIELD_ENGINEER') {
    conditions.push(`wo.assigned_to = $${paramIndex++}`);
    params.push(user.user_id);
  }
  return { conditions, params, nextIndex: paramIndex };
}

router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const status = req.query.status;
    const zoneId = req.query.zone_id;
    const { conditions, params, nextIndex } = buildRoleFilter(req.user);
    let idx = nextIndex;

    if (status) {
      conditions.push(`wo.ticket_status = $${idx++}`);
      params.push(status);
    }
    if (zoneId && req.user.role !== 'GVMC_EE' && req.user.role !== 'FIELD_ENGINEER') {
      conditions.push(`w.zone_id = $${idx++}`);
      params.push(parseInt(zoneId));
    }

    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(limit, offset);

    const rows = await db.manyOrNone(`
      SELECT wo.work_order_id, wo.pole_id, wo.contractor_id, wo.assigned_to,
             wo.fault_category, wo.fault_description, wo.reported_by,
             wo.reported_timestamp, wo.assigned_timestamp, wo.resolved_timestamp,
             wo.sla_deadline, wo.ticket_status, wo.resolution_notes,
             wo.penalty_deducted, wo.penalty_type, wo.days_overdue,
             p.pole_number, p.luminaire_wattage, p.wiring_type,
             c.company_name AS contractor_name,
             u.full_name AS assigned_to_name,
             z.zone_name, w.ward_number
      FROM work_orders wo
      JOIN poles p ON wo.pole_id = p.pole_id
      JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id
      JOIN wards w ON jb.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      LEFT JOIN contractors c ON wo.contractor_id = c.contractor_id
      LEFT JOIN users u ON wo.assigned_to = u.user_id
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

router.get('/sla-breaches', async (req, res) => {
  try {
    const { conditions, params, nextIndex } = buildRoleFilter(req.user);
    let idx = nextIndex;
    conditions.push(`wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS')`);
    conditions.push(`NOW() > wo.sla_deadline`);
    params.push(50);
    const rows = await db.manyOrNone(`
      SELECT wo.work_order_id, wo.pole_id, wo.fault_category,
             wo.reported_timestamp, wo.sla_deadline, wo.ticket_status,
             wo.days_overdue, p.pole_number, z.zone_name, w.ward_number,
             c.company_name AS contractor_name,
             EXTRACT(EPOCH FROM (NOW() - wo.sla_deadline))/3600.0 AS hours_overdue
      FROM work_orders wo
      JOIN poles p ON wo.pole_id = p.pole_id
      JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id
      JOIN wards w ON jb.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      LEFT JOIN contractors c ON wo.contractor_id = c.contractor_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY wo.sla_deadline ASC LIMIT $${idx}
    `, params);
    res.json({ ok: true, count: rows.length, breaches: rows });
  } catch (err) {
    logger.error('SLA breaches error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const workOrderId = parseInt(req.params.id, 10);
    if (!Number.isInteger(workOrderId)) return res.status(400).json({ ok: false, error: 'Invalid work order id' });
    const wo = await db.oneOrNone(`
      SELECT wo.*, p.pole_number, p.luminaire_wattage, p.wiring_type,
             c.company_name AS contractor_name, u.full_name AS assigned_to_name,
             z.zone_name, w.ward_number
      FROM work_orders wo
      JOIN poles p ON wo.pole_id = p.pole_id
      JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id
      JOIN wards w ON jb.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      LEFT JOIN contractors c ON wo.contractor_id = c.contractor_id
      LEFT JOIN users u ON wo.assigned_to = u.user_id
      WHERE wo.work_order_id = $1`, [workOrderId]);
    if (!wo) return res.status(404).json({ ok: false, error: 'Work order not found' });
    if (req.user.role === 'CONTRACTOR' && wo.contractor_id !== req.user.contractor_id) return res.status(403).json({ ok: false, error: 'Access denied' });
    if (req.user.role === 'GVMC_EE' && wo.zone_id !== req.user.zone_id) return res.status(403).json({ ok: false, error: 'Access denied' });
    if (req.user.role === 'FIELD_ENGINEER' && wo.assigned_to !== req.user.user_id) return res.status(403).json({ ok: false, error: 'Work order is not assigned to this field engineer' });
    res.json({ ok: true, data: wo });
  } catch (err) {
    logger.error('Get work order error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.post('/', requireRole('SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE'), async (req, res) => {
  const { error, value } = createSchema.validate(req.body);
  if (error) return res.status(400).json({ ok: false, error: error.details[0].message });
  try {
    const pole = await db.oneOrNone(`SELECT p.pole_id, z.zone_id FROM poles p JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id JOIN wards w ON jb.ward_id = w.ward_id JOIN zones z ON w.zone_id = z.zone_id WHERE p.pole_id = $1`, [value.pole_id]);
    if (!pole) return res.status(404).json({ ok: false, error: 'Pole not found' });
    if (req.user.role === 'GVMC_EE' && pole.zone_id !== req.user.zone_id) return res.status(403).json({ ok: false, error: 'Cannot create a work order outside your zone' });
    if (value.contractor_id) {
      const contractor = await db.oneOrNone('SELECT contractor_id, assigned_zone_id, is_active FROM contractors WHERE contractor_id = $1', [value.contractor_id]);
      if (!contractor || !contractor.is_active) return res.status(400).json({ ok: false, error: 'Contractor not found or inactive' });
      if (contractor.assigned_zone_id && contractor.assigned_zone_id !== pole.zone_id) return res.status(400).json({ ok: false, error: 'Contractor is not assigned to the work order zone' });
    }
    const existing = await db.oneOrNone(`SELECT work_order_id FROM work_orders WHERE pole_id = $1 AND fault_category = $2 AND ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED') LIMIT 1`, [value.pole_id, value.fault_category]);
    if (existing) return res.status(409).json({ ok: false, error: 'Open ticket already exists for this pole and fault type', existing_work_order_id: existing.work_order_id });
    const wo = await db.one(`INSERT INTO work_orders (pole_id, contractor_id, fault_category, fault_description, reported_by, reported_timestamp) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *`, [value.pole_id, value.contractor_id || null, value.fault_description || null, value.fault_description || null, value.reported_by || req.user.full_name]);
    await auditLog(req.user.user_id, 'WORK_ORDER_CREATED', 'work_orders', wo.work_order_id, true, { fault_category: value.fault_category }, req);
    logger.info('Work order created', { work_order_id: wo.work_order_id, by: req.user.user_id });
    res.status(201).json({ ok: true, data: wo });
  } catch (err) {
    logger.error('Create work order error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.patch('/:id', requireRole('SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','CONTRACTOR','FIELD_ENGINEER'), async (req, res) => {
  const { error, value } = updateSchema.validate(req.body);
  if (error) return res.status(400).json({ ok: false, error: error.details[0].message });
  try {
    const workOrderId = parseInt(req.params.id, 10);
    if (!Number.isInteger(workOrderId)) return res.status(400).json({ ok: false, error: 'Invalid work order id' });
    const wo = await db.oneOrNone(`SELECT wo.*, z.zone_id FROM work_orders wo JOIN poles p ON wo.pole_id = p.pole_id JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id JOIN wards w ON jb.ward_id = w.ward_id JOIN zones z ON w.zone_id = z.zone_id WHERE wo.work_order_id = $1`, [workOrderId]);
    if (!wo) return res.status(404).json({ ok: false, error: 'Work order not found' });
    if (req.user.role === 'CONTRACTOR' && wo.contractor_id !== req.user.contractor_id) return res.status(403).json({ ok: false, error: 'Access denied' });
    if (req.user.role === 'GVMC_EE' && wo.zone_id !== req.user.zone_id) return res.status(403).json({ ok: false, error: 'Access denied' });
    if (req.user.role === 'FIELD_ENGINEER' && wo.assigned_to !== req.user.user_id) return res.status(403).json({ ok: false, error: 'Work order is not assigned to this field engineer' });
    const updates = [], params = [];
    let idx = 1;
    if (value.resolution_notes !== undefined) { updates.push(`resolution_notes = $${idx++}`); params.push(value.resolution_notes); }
    if (value.resolved_timestamp !== undefined) { updates.push(`resolved_timestamp = $${idx++}`); params.push(value.resolved_timestamp); }
    params.push(workOrderId);
    await db.none(`UPDATE work_orders SET ${updates.join(', ')} WHERE work_order_id = $${idx}`, params);
    await auditLog(req.user.user_id, 'WORK_ORDER_NOTES_UPDATED', 'work_orders', workOrderId, true, { changes: value }, req);
    res.json({ ok: true, message: 'Work order updated' });
  } catch (err) {
    logger.error('Update work order error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.patch('/:id/verify', requireRole('SUPER_ADMIN', 'GVMC_COMMISSIONER', 'GVMC_EE', 'FIELD_ENGINEER'), async (req, res) => {
  const workOrderId = parseInt(req.params.id);
  const { verified_fault } = req.body;
  if (!verified_fault) return res.status(400).json({ ok: false, error: 'verified_fault is required' });
  try {
    const wo = await db.oneOrNone(`SELECT work_order_id, recommended_fault, confidence_pct, possible_causes, model_version, assigned_to, contractor_id FROM work_orders WHERE work_order_id = $1`, [workOrderId]);
    if (!wo) return res.status(404).json({ ok: false, error: 'Work order not found' });
    if (req.user.role === 'FIELD_ENGINEER' && wo.assigned_to !== req.user.user_id) return res.status(403).json({ ok: false, error: 'Work order is not assigned to this field engineer' });
    if (req.user.role === 'CONTRACTOR') return res.status(403).json({ ok: false, error: 'Contractors cannot perform GVMC verification' });
    if (!wo.recommended_fault) return res.status(400).json({ ok: false, error: 'This work order has no system recommendation to verify' });
    const correctPrediction = wo.recommended_fault === verified_fault;
    await db.none(`UPDATE work_orders SET verified_fault = $1, verified_by = $2, verified_at = NOW() WHERE work_order_id = $3`, [verified_fault, req.user.user_id, workOrderId]);
    await db.none(`INSERT INTO fault_feedback (work_order_id, recommended_fault, confidence_pct, verified_fault, correct_prediction, model_version, evidence, reviewed_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [workOrderId, wo.recommended_fault, wo.confidence_pct, verified_fault, correctPrediction, wo.model_version, JSON.stringify(wo.possible_causes), req.user.user_id]);
    await auditLog(req.user.user_id, 'WORK_ORDER_VERIFIED', 'work_orders', workOrderId, true, { recommended: wo.recommended_fault, verified: verified_fault, correct: correctPrediction }, req);
    res.json({ ok: true, message: correctPrediction ? 'Verified — system recommendation was correct' : 'Verified — system recommendation was corrected', recommended_fault: wo.recommended_fault, verified_fault, correct_prediction: correctPrediction });
  } catch (err) {
    logger.error('Verify work order error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.get('/accuracy/summary', requireRole('SUPER_ADMIN', 'GVMC_COMMISSIONER', 'GVMC_EE'), async (req, res) => {
  try {
    const zoneId = req.user.role === 'GVMC_EE' ? req.user.zone_id : null;
    if (req.user.role === 'GVMC_EE' && !zoneId) {
      return res.status(403).json({ ok: false, error: 'Access denied: user has no assigned zone' });
    }
    const filter = zoneId ? 'WHERE w.zone_id = $1' : '';
    const params = zoneId ? [zoneId] : [];
    const join = zoneId ? `
      FROM fault_feedback ff
      JOIN work_orders wo ON wo.work_order_id = ff.work_order_id
      JOIN poles p ON p.pole_id = wo.pole_id
      JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id
      JOIN wards w ON jb.ward_id = w.ward_id` : 'FROM fault_feedback ff';
    const overall = await db.oneOrNone(`
      SELECT COUNT(*) AS total_verified,
             COUNT(*) FILTER (WHERE correct_prediction) AS correct_count,
             ROUND(COUNT(*) FILTER (WHERE correct_prediction)::NUMERIC / NULLIF(COUNT(*), 0) * 100, 1) AS accuracy_pct
      ${join} ${filter}
    `, params);
    const byFaultType = await db.manyOrNone(`
      SELECT recommended_fault, COUNT(*) AS total,
             COUNT(*) FILTER (WHERE correct_prediction) AS correct,
             ROUND(COUNT(*) FILTER (WHERE correct_prediction)::NUMERIC / NULLIF(COUNT(*), 0) * 100, 1) AS accuracy_pct
      ${join} ${filter}
      GROUP BY recommended_fault ORDER BY total DESC
    `, params);
    const byModelVersion = await db.manyOrNone(`
      SELECT model_version, COUNT(*) AS total,
             COUNT(*) FILTER (WHERE correct_prediction) AS correct,
             ROUND(COUNT(*) FILTER (WHERE correct_prediction)::NUMERIC / NULLIF(COUNT(*), 0) * 100, 1) AS accuracy_pct
      ${join} ${filter}
      GROUP BY model_version ORDER BY model_version
    `, params);
    res.json({ ok: true, overall: overall || { total_verified: 0, correct_count: 0, accuracy_pct: null }, by_fault_type: byFaultType, by_model_version: byModelVersion, note: overall?.total_verified > 0 ? null : 'No verifications logged yet — accuracy figures will populate as field engineers confirm real recommendations.' });
  } catch (err) {
    logger.error('Accuracy summary error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

module.exports = router;
