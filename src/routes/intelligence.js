'use strict';

const express = require('express');
const db = require('../../config/database');
const logger = require('../utils/logger');
const { requireAuth, requireRole, auditLog } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('SUPER_ADMIN', 'GVMC_COMMISSIONER', 'GVMC_EE', 'CONTRACTOR', 'FIELD_ENGINEER', 'READ_ONLY'));

function scopePole(user, params, conditions, alias = 'p') {
  if (user.role === 'GVMC_EE') {
    params.push(user.zone_id);
    conditions.push(`EXISTS (SELECT 1 FROM junction_boxes jb0 JOIN wards w0 ON w0.ward_id = jb0.ward_id WHERE jb0.cabinet_id = ${alias}.cabinet_id AND w0.zone_id = $${params.length})`);
  }
  if (user.role === 'CONTRACTOR') {
    params.push(user.contractor_id);
    conditions.push(`EXISTS (SELECT 1 FROM work_orders wo0 WHERE wo0.pole_id = ${alias}.pole_id AND wo0.contractor_id = $${params.length})`);
  }
}

function reliabilitySql() {
  return `
    WITH failures AS (
      SELECT wo.pole_id, wo.work_order_id, wo.reported_timestamp, wo.resolved_timestamp,
             wo.fault_category,
             LAG(wo.reported_timestamp) OVER (PARTITION BY wo.pole_id ORDER BY wo.reported_timestamp) AS prev_failure
      FROM work_orders wo
      WHERE wo.ticket_status <> 'CANCELLED'
    ),
    agg AS (
      SELECT p.pole_id,
             COUNT(f.work_order_id) FILTER (WHERE f.reported_timestamp >= NOW() - INTERVAL '90 days')::int AS repair_count_90d,
             COUNT(f.work_order_id) FILTER (WHERE f.reported_timestamp >= NOW() - INTERVAL '365 days')::int AS repair_count_365d,
             COUNT(f.work_order_id) FILTER (WHERE f.reported_timestamp >= NOW() - INTERVAL '90 days' AND f.prev_failure IS NOT NULL)::int AS recurrence_count_90d,
             ROUND(AVG(EXTRACT(EPOCH FROM (f.resolved_timestamp - f.reported_timestamp))/3600.0)
               FILTER (WHERE f.resolved_timestamp IS NOT NULL AND f.reported_timestamp >= NOW() - INTERVAL '365 days'), 2) AS mttr_hours_365d,
             ROUND(AVG(EXTRACT(EPOCH FROM (f.reported_timestamp - f.prev_failure))/3600.0)
               FILTER (WHERE f.prev_failure IS NOT NULL AND f.reported_timestamp >= NOW() - INTERVAL '365 days'), 2) AS mtbf_hours_365d,
             MAX(f.reported_timestamp) AS last_failure_at,
             (ARRAY_AGG(f.fault_category ORDER BY f.reported_timestamp DESC))[1] AS dominant_fault_category
      FROM poles p
      LEFT JOIN failures f ON f.pole_id = p.pole_id
      GROUP BY p.pole_id
    )
    SELECT a.*,
           ROUND(GREATEST(0, LEAST(100,
             (a.repair_count_90d * 15) +
             (a.recurrence_count_90d * 10) +
             (CASE WHEN a.mttr_hours_365d > 72 THEN 20 WHEN a.mttr_hours_365d > 48 THEN 12 WHEN a.mttr_hours_365d > 24 THEN 6 ELSE 0 END) +
             (CASE WHEN a.repair_count_365d >= 8 THEN 20 WHEN a.repair_count_365d >= 5 THEN 12 WHEN a.repair_count_365d >= 3 THEN 6 ELSE 0 END)
           )), 2) AS risk_score,
           CASE
             WHEN a.repair_count_90d >= 4 OR a.repair_count_365d >= 8 THEN 'CRITICAL'
             WHEN a.repair_count_90d >= 2 OR a.repair_count_365d >= 5 THEN 'HIGH'
             WHEN a.repair_count_90d >= 1 OR a.repair_count_365d >= 3 THEN 'MEDIUM'
             ELSE 'LOW'
           END AS risk_band,
           CASE WHEN a.last_failure_at IS NULL THEN NULL
                ELSE ROUND(EXTRACT(EPOCH FROM (NOW() - a.last_failure_at))/86400.0, 2) END AS days_since_last_repair
    FROM agg a`;
}

router.get('/reliability/summary', async (req, res) => {
  try {
    const params = [], conditions = [];
    scopePole(req.user, params, conditions);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await db.manyOrNone(`SELECT r.* FROM (${reliabilitySql()}) r JOIN poles p ON p.pole_id = r.pole_id ${where} ORDER BY r.risk_score DESC, r.repair_count_90d DESC LIMIT 500`, params);
    const distribution = rows.reduce((a, r) => { a[r.risk_band] = (a[r.risk_band] || 0) + 1; return a; }, {});
    res.json({ ok: true, generated_at: new Date().toISOString(), methodology: 'Deterministic advisory score; explainable from repair recurrence and resolution history.', distribution, data: rows });
  } catch (err) {
    logger.error('Reliability summary error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.get('/reliability/:poleId', async (req, res) => {
  const poleId = Number.parseInt(req.params.poleId, 10);
  if (!Number.isInteger(poleId)) return res.status(400).json({ ok: false, error: 'Invalid pole id' });
  try {
    const params = [poleId], conditions = [];
    scopePole(req.user, params, conditions);
    const scope = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
    const row = await db.oneOrNone(`SELECT p.pole_id, p.pole_number, p.current_status, p.luminaire_wattage, p.installation_date, r.* FROM poles p JOIN (${reliabilitySql()}) r ON r.pole_id = p.pole_id WHERE p.pole_id = $1 ${scope}`, params);
    if (!row) return res.status(404).json({ ok: false, error: 'Pole not found' });
    const [orders, telemetry] = await Promise.all([
      db.manyOrNone(`SELECT work_order_id, fault_category, ticket_status, reported_timestamp, resolved_timestamp, resolution_notes FROM work_orders WHERE pole_id=$1 ORDER BY reported_timestamp DESC LIMIT 50`, [poleId]),
      db.manyOrNone(`SELECT time_bucket('1 day', timestamp) AS day, ROUND(AVG(voltage_rms),2) voltage_avg, ROUND(AVG(current_rms),3) current_avg, ROUND(AVG(active_power),2) power_avg, ROUND(AVG(power_factor),3) power_factor_avg, ROUND(AVG(temperature),2) temperature_avg FROM node_telemetry WHERE pole_number=$2 AND timestamp >= NOW()-INTERVAL '30 days' GROUP BY 1 ORDER BY 1 DESC LIMIT 30`, [poleId, row.pole_number])
    ]);
    res.json({ ok: true, asset: row, work_orders: orders, telemetry_30d: telemetry });
  } catch (err) {
    logger.error('Reliability detail error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.get('/contracts', async (req, res) => {
  try {
    const params = [], conditions = [];
    if (req.user.role === 'GVMC_EE') { params.push(req.user.zone_id); conditions.push(`EXISTS (SELECT 1 FROM contract_segments cs0 WHERE cs0.contract_id=c.contract_id AND cs0.zone_id=$${params.length})`); }
    if (req.user.role === 'CONTRACTOR') { params.push(req.user.contractor_id); conditions.push(`c.contractor_id=$${params.length}`); }
    const rows = await db.manyOrNone(`SELECT c.*, co.company_name, COUNT(cs.segment_id)::int AS segment_count FROM municipal_contracts c JOIN contractors co ON co.contractor_id=c.contractor_id LEFT JOIN contract_segments cs ON cs.contract_id=c.contract_id ${conditions.length ? 'WHERE '+conditions.join(' AND ') : ''} GROUP BY c.contract_id,co.company_name ORDER BY c.end_date NULLS LAST,c.contract_id DESC`, params);
    res.json({ ok: true, data: rows });
  } catch (err) {
    logger.error('Contract intelligence error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.get('/contracts/:id', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'Invalid contract id' });
  try {
    const c = await db.oneOrNone(`SELECT c.*, co.company_name FROM municipal_contracts c JOIN contractors co ON co.contractor_id=c.contractor_id WHERE c.contract_id=$1`, [id]);
    if (!c) return res.status(404).json({ ok: false, error: 'Contract not found' });
    if (req.user.role === 'CONTRACTOR' && c.contractor_id !== req.user.contractor_id) return res.status(403).json({ ok: false, error: 'Access denied' });
    const [segments, orders, penalties] = await Promise.all([
      db.manyOrNone(`SELECT segment_id,segment_name,zone_id,ward_id,target_asset_count FROM contract_segments WHERE contract_id=$1 ORDER BY segment_id`, [id]),
      db.manyOrNone(`SELECT wo.work_order_id,wo.pole_id,wo.fault_category,wo.ticket_status,wo.reported_timestamp,wo.resolved_timestamp,wo.penalty_deducted FROM work_orders wo JOIN contractors co ON co.contractor_id=wo.contractor_id WHERE co.contractor_id=$2 AND wo.reported_timestamp BETWEEN COALESCE($1::date,'1900-01-01') AND COALESCE(($3::date + INTERVAL '1 day'),'2999-01-01') ORDER BY wo.reported_timestamp DESC LIMIT 500`, [c.start_date, c.contractor_id, c.end_date]),
      db.manyOrNone(`SELECT l.* FROM contractor_penalty_ledger l WHERE l.contractor_id=$1 ORDER BY assessed_at DESC LIMIT 100`, [c.contractor_id])
    ]);
    res.json({ ok: true, contract: c, segments, execution: orders, penalties });
  } catch (err) {
    logger.error('Contract detail error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.get('/procurement', async (req, res) => {
  try {
    const rows = await db.manyOrNone(`SELECT pr.*, c.contract_number, co.company_name FROM procurement_records pr LEFT JOIN municipal_contracts c ON c.contract_id=pr.contract_id LEFT JOIN contractors co ON co.contractor_id=c.contractor_id ORDER BY COALESCE(pr.award_date,pr.notice_date) DESC NULLS LAST, pr.procurement_id DESC LIMIT 500`);
    const totals = await db.one(`SELECT COUNT(*)::int total_records, COALESCE(SUM(estimated_value_inr),0) estimated_value_inr, COALESCE(SUM(awarded_value_inr),0) awarded_value_inr FROM procurement_records`);
    res.json({ ok: true, totals, data: rows });
  } catch (err) {
    logger.error('Procurement intelligence error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.get('/finance', async (req, res) => {
  try {
    const params = [], where = [];
    if (req.user.role === 'CONTRACTOR') { params.push(req.user.contractor_id); where.push(`c.contractor_id=$${params.length}`); }
    if (req.user.role === 'GVMC_EE') { params.push(req.user.zone_id); where.push(`c.assigned_zone_id=$${params.length}`); }
    const rows = await db.manyOrNone(`SELECT c.contractor_id,c.company_name,c.monthly_invoice_base,c.total_penalty_mtd,COALESCE(SUM(l.amount_inr),0) ledger_penalties, ROUND(c.monthly_invoice_base-c.total_penalty_mtd,2) net_payable_basis FROM contractors c LEFT JOIN contractor_penalty_ledger l ON l.contractor_id=c.contractor_id ${where.length?'WHERE '+where.join(' AND '):''} GROUP BY c.contractor_id ORDER BY c.total_penalty_mtd DESC`, params);
    res.json({ ok: true, data: rows });
  } catch (err) {
    logger.error('Finance intelligence error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.get('/spatial/zones', async (req, res) => {
  try {
    const rows = await db.manyOrNone(`SELECT g.*, COUNT(wo.work_order_id) FILTER (WHERE wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED'))::int open_work_orders, COUNT(wo.work_order_id) FILTER (WHERE wo.ticket_status='SLA_VIOLATED')::int sla_violations FROM v_zone_glow_rates g LEFT JOIN wards w ON w.zone_id=g.zone_id LEFT JOIN junction_boxes jb ON jb.ward_id=w.ward_id LEFT JOIN poles p ON p.cabinet_id=jb.cabinet_id LEFT JOIN work_orders wo ON wo.pole_id=p.pole_id GROUP BY g.zone_id,g.zone_name,g.total_poles,g.operational_poles,g.glow_rate_pct,g.faulty_poles,g.day_burn_poles ORDER BY g.glow_rate_pct ASC`);
    res.json({ ok: true, data: rows });
  } catch (err) {
    logger.error('Spatial intelligence error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.get('/predictive/alerts', async (req, res) => {
  try {
    const rows = await db.manyOrNone(`SELECT a.alert_id,a.pole_id,p.pole_number,a.alert_type,a.severity,a.status,a.score,a.reason,a.evidence,a.generated_at FROM predictive_alerts a LEFT JOIN poles p ON p.pole_id=a.pole_id WHERE a.status IN ('OPEN','ACKNOWLEDGED') ORDER BY a.score DESC NULLS LAST,a.generated_at DESC LIMIT 500`);
    res.json({ ok: true, advisory: true, data: rows });
  } catch (err) {
    logger.error('Predictive alert error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.post('/predictive/alerts/:id/acknowledge', requireRole('SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE'), async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'Invalid alert id' });
  try {
    const row = await db.oneOrNone(`UPDATE predictive_alerts SET status='ACKNOWLEDGED',acknowledged_at=NOW(),acknowledged_by=$2 WHERE alert_id=$1 AND status='OPEN' RETURNING *`, [id, req.user.user_id]);
    if (!row) return res.status(404).json({ ok: false, error: 'Open alert not found' });
    await auditLog(req.user.user_id, 'PREDICTIVE_ALERT_ACKNOWLEDGED', 'predictive_alert', id, { pole_id: row.pole_id });
    res.json({ ok: true, data: row });
  } catch (err) {
    logger.error('Predictive alert acknowledgement error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.get('/knowledge', async (req, res) => {
  try {
    const category = req.query.category ? String(req.query.category).slice(0,60) : null;
    const rows = await db.manyOrNone(`SELECT knowledge_id,title,category,body,source_reference,effective_from,effective_to,version,status,metadata,updated_at FROM municipal_knowledge_items WHERE status='ACTIVE' AND ($1::text IS NULL OR category=$1) ORDER BY category,title`, [category]);
    res.json({ ok: true, data: rows });
  } catch (err) {
    logger.error('Knowledge base error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.post('/knowledge', requireRole('SUPER_ADMIN','GVMC_COMMISSIONER'), async (req, res) => {
  const { title, category, body, source_reference, effective_from, effective_to, version, metadata } = req.body || {};
  if (!title || !category || !body) return res.status(400).json({ ok: false, error: 'title, category and body are required' });
  try {
    const row = await db.one(`INSERT INTO municipal_knowledge_items(title,category,body,source_reference,effective_from,effective_to,version,metadata,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [String(title),String(category),String(body),source_reference || null,effective_from || null,effective_to || null,version || null,metadata || {},req.user.user_id]);
    await auditLog(req.user.user_id, 'KNOWLEDGE_ITEM_CREATED', 'municipal_knowledge_item', row.knowledge_id, { category: row.category });
    res.status(201).json({ ok: true, data: row });
  } catch (err) {
    logger.error('Knowledge item create error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.get('/executive', async (req, res) => {
  try {
    const [city, reliability, finance, sla] = await Promise.all([
      db.one(`SELECT COUNT(*)::int total_assets, COUNT(*) FILTER(WHERE current_status='OPERATIONAL')::int operational, COUNT(*) FILTER(WHERE current_status='FAULTY')::int faulty, COUNT(*) FILTER(WHERE current_status='UNDER_REPAIR')::int under_repair, COUNT(*) FILTER(WHERE current_status='NO_SIGNAL')::int no_signal, COUNT(*) FILTER(WHERE current_status='DAY_BURN')::int day_burn FROM poles`),
      db.one(`SELECT COUNT(*) FILTER(WHERE repair_count_90d>=4 OR repair_count_365d>=8)::int critical, COUNT(*) FILTER(WHERE repair_count_90d>=2 OR repair_count_365d>=5)::int high FROM (${reliabilitySql()}) r`),
      db.one(`SELECT COALESCE(SUM(monthly_invoice_base),0) invoice_base, COALESCE(SUM(total_penalty_mtd),0) penalties_mtd FROM contractors`),
      db.one(`SELECT COUNT(*) FILTER(WHERE ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS'))::int open_orders, COUNT(*) FILTER(WHERE ticket_status='SLA_VIOLATED')::int sla_violations FROM work_orders`)
    ]);
    res.json({ ok: true, generated_at: new Date().toISOString(), city, reliability, finance, sla, advisory: 'Executive intelligence aggregates existing operational facts; it does not alter SLA or glow-rate calculations.' });
  } catch (err) {
    logger.error('Executive intelligence error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.get('/governance/data-quality', async (req, res) => {
  try {
    const [orphanNodes, missingGeo, unresolvedOwners, staleTelemetry] = await Promise.all([
      db.one(`SELECT COUNT(*)::int count FROM poles WHERE node_id IS NULL AND current_status NOT IN ('DECOMMISSIONED')`),
      db.one(`SELECT COUNT(*)::int count FROM poles WHERE geolocation IS NULL`),
      db.one(`SELECT COUNT(*)::int count FROM work_orders WHERE ticket_status IN ('ASSIGNED','IN_PROGRESS') AND assigned_to IS NULL`),
      db.one(`SELECT COUNT(*)::int count FROM poles p WHERE p.node_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM node_telemetry t WHERE t.pole_number=p.pole_number AND t.timestamp>=NOW()-INTERVAL '15 minutes') AND p.current_status NOT IN ('DECOMMISSIONED')`)
    ]);
    res.json({ ok: true, generated_at: new Date().toISOString(), checks: { poles_without_node: orphanNodes.count, poles_without_geolocation: missingGeo.count, active_orders_without_assignee: unresolvedOwners.count, nodes_without_recent_telemetry: staleTelemetry.count } });
  } catch (err) {
    logger.error('Data quality error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.get('/reports/overview', async (req, res) => {
  try {
    const [zones, contractors, faults] = await Promise.all([
      db.manyOrNone(`SELECT * FROM v_zone_glow_rates ORDER BY glow_rate_pct ASC`),
      db.manyOrNone(`SELECT * FROM v_contractor_kpis ORDER BY sla_violations_mtd DESC`),
      db.manyOrNone(`SELECT fault_category,COUNT(*)::int count FROM work_orders GROUP BY fault_category ORDER BY count DESC`)
    ]);
    res.json({ ok: true, generated_at: new Date().toISOString(), zones, contractors, faults });
  } catch (err) {
    logger.error('Overview report error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

module.exports = router;
