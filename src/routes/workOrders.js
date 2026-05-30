const express = require('express');
const Joi     = require('joi');
const router  = express.Router();
const db      = require('../../config/database');
const logger  = require('../utils/logger');
const ws      = require('../websocket/wsServer');

const createSchema = Joi.object({
  pole_id:           Joi.number().integer().positive().required(),
  fault_category:    Joi.string().valid(
    'DRIVER_FAULT','LINE_FAULT','DAY_BURNING_FAULT','PREDICTIVE_DEGRADATION',
    'PHYSICAL_DAMAGE','CABLE_THEFT','CABINET_FAULT','MANUAL_REPORT'
  ).required(),
  fault_description: Joi.string().max(1000).optional(),
  reported_by:       Joi.string().max(100).optional(),
});

router.get('/', async (req, res) => {
  const { status, contractor_id, zone_id, page=1, limit=50, fault_category } = req.query;
  const offset = (parseInt(page)-1) * parseInt(limit);
  const params=[], where=[];

  if (status)         { params.push(status);         where.push(`wo.ticket_status=$${params.length}`); }
  if (contractor_id)  { params.push(contractor_id);  where.push(`wo.contractor_id=$${params.length}`); }
  if (fault_category) { params.push(fault_category); where.push(`wo.fault_category=$${params.length}`); }
  if (zone_id)        { params.push(zone_id);        where.push(`z.zone_id=$${params.length}`); }

  const whereClause = where.length ? 'WHERE '+where.join(' AND ') : '';

  try {
    params.push(parseInt(limit), offset);
    const rows = await db.manyOrNone(`
      SELECT wo.work_order_id, wo.pole_id, p.pole_number, p.luminaire_wattage,
             w.secretariat_code, w.ward_amenity_sec_name, z.zone_name,
             c.company_name AS contractor_name, wo.fault_category,
             wo.reported_timestamp, wo.sla_deadline, wo.resolved_timestamp,
             wo.ticket_status, wo.days_overdue, wo.penalty_deducted
      FROM work_orders wo
      JOIN poles p ON wo.pole_id=p.pole_id
      JOIN junction_boxes jb ON p.cabinet_id=jb.cabinet_id
      JOIN wards w ON jb.ward_id=w.ward_id
      JOIN zones z ON w.zone_id=z.zone_id
      LEFT JOIN contractors c ON wo.contractor_id=c.contractor_id
      ${whereClause}
      ORDER BY wo.reported_timestamp DESC
      LIMIT $${params.length-1} OFFSET $${params.length}
    `, params);

    const { count } = await db.one(`
      SELECT COUNT(*) FROM work_orders wo
      JOIN poles p ON wo.pole_id=p.pole_id
      JOIN junction_boxes jb ON p.cabinet_id=jb.cabinet_id
      JOIN wards w ON jb.ward_id=w.ward_id
      JOIN zones z ON w.zone_id=z.zone_id
      LEFT JOIN contractors c ON wo.contractor_id=c.contractor_id
      ${whereClause}
    `, params.slice(0,-2));

    res.json({ ok:true, total:parseInt(count), page:parseInt(page), limit:parseInt(limit), data:rows });
  } catch(err) {
    logger.error('Work order list error', { error: err.message });
    res.status(500).json({ ok:false, error:'Internal server error' });
  }
});

router.get('/sla-breaches', async (req, res) => {
  try {
    const rows = await db.manyOrNone('SELECT * FROM v_sla_breaches LIMIT 500');
    res.json({ ok:true, count:rows.length, breaches:rows });
  } catch(err) { res.status(500).json({ ok:false, error:'Internal server error' }); }
});

router.get('/stats', async (req, res) => {
  try {
    const stats = await db.one(`
      SELECT
        COUNT(*)                                              AS total_all_time,
        COUNT(*) FILTER (WHERE ticket_status='PENDING')      AS pending,
        COUNT(*) FILTER (WHERE ticket_status='ASSIGNED')     AS assigned,
        COUNT(*) FILTER (WHERE ticket_status='RESOLVED')     AS resolved,
        COUNT(*) FILTER (WHERE ticket_status='SLA_VIOLATED') AS sla_violated,
        COALESCE(SUM(penalty_deducted),0)                    AS total_penalties_inr,
        ROUND(AVG(days_overdue) FILTER (WHERE days_overdue>0),2) AS avg_days_overdue
      FROM work_orders
    `);
    const byFault = await db.manyOrNone(`
      SELECT fault_category, COUNT(*) AS count
      FROM work_orders GROUP BY fault_category ORDER BY count DESC
    `);
    res.json({ ok:true, city_totals:stats, by_fault_category:byFault });
  } catch(err) { res.status(500).json({ ok:false, error:'Internal server error' }); }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await db.oneOrNone(`
      SELECT wo.*, p.pole_number, p.luminaire_wattage, p.wiring_type,
             w.secretariat_code, w.ward_amenity_sec_name, w.ward_amenity_sec_phone,
             z.zone_name, c.company_name AS contractor_name
      FROM work_orders wo
      JOIN poles p ON wo.pole_id=p.pole_id
      JOIN junction_boxes jb ON p.cabinet_id=jb.cabinet_id
      JOIN wards w ON jb.ward_id=w.ward_id
      JOIN zones z ON w.zone_id=z.zone_id
      LEFT JOIN contractors c ON wo.contractor_id=c.contractor_id
      WHERE wo.work_order_id=$1
    `, [req.params.id]);
    if (!row) return res.status(404).json({ ok:false, error:'Work order not found' });
    res.json({ ok:true, data:row });
  } catch(err) { res.status(500).json({ ok:false, error:'Internal server error' }); }
});

router.post('/', async (req, res) => {
  const { error, value } = createSchema.validate(req.body);
  if (error) return res.status(400).json({ ok:false, error:error.details[0].message });

  try {
    const cr = await db.oneOrNone(`
      SELECT c.contractor_id FROM poles p
      JOIN junction_boxes jb ON p.cabinet_id=jb.cabinet_id
      JOIN wards w ON jb.ward_id=w.ward_id
      JOIN zones z ON w.zone_id=z.zone_id
      JOIN contractors c ON c.assigned_zone_id=z.zone_id
      WHERE p.pole_id=$1 LIMIT 1
    `, [value.pole_id]);

    const wo = await db.one(`
      INSERT INTO work_orders (pole_id, contractor_id, fault_category, fault_description, reported_by)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [value.pole_id, cr?.contractor_id||null, value.fault_category, value.fault_description||null, value.reported_by||'MANUAL']);

    ws.broadcastAlert('NEW_WORK_ORDER', { work_order_id:wo.work_order_id, fault_category:wo.fault_category });
    res.status(201).json({ ok:true, data:wo });
  } catch(err) {
    logger.error('Work order create error', { error:err.message });
    res.status(500).json({ ok:false, error:'Internal server error' });
  }
});

router.patch('/:id/assign', async (req, res) => {
  try {
    const wo = await db.oneOrNone(`
      UPDATE work_orders SET ticket_status='ASSIGNED', assigned_timestamp=NOW()
      WHERE work_order_id=$1 AND ticket_status IN ('PENDING','SLA_VIOLATED') RETURNING *
    `, [req.params.id]);
    if (!wo) return res.status(404).json({ ok:false, error:'Not found or already assigned' });
    res.json({ ok:true, data:wo });
  } catch(err) { res.status(500).json({ ok:false, error:'Internal server error' }); }
});

router.patch('/:id/resolve', async (req, res) => {
  try {
    const wo = await db.oneOrNone(`
      UPDATE work_orders SET ticket_status='RESOLVED', resolved_timestamp=NOW(), resolution_notes=$2
      WHERE work_order_id=$1 AND ticket_status NOT IN ('RESOLVED','CANCELLED') RETURNING *
    `, [req.params.id, req.body.resolution_notes||null]);
    if (!wo) return res.status(404).json({ ok:false, error:'Not found or already resolved' });
    ws.broadcastAlert('WORK_ORDER_RESOLVED', { work_order_id:wo.work_order_id });
    res.json({ ok:true, data:wo });
  } catch(err) { res.status(500).json({ ok:false, error:'Internal server error' }); }
});

module.exports = router;