'use strict';

const express = require('express');
const db = require('../../config/database');
const logger = require('../utils/logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('SUPER_ADMIN', 'GVMC_COMMISSIONER', 'GVMC_EE', 'CONTRACTOR', 'READ_ONLY'));

function assertScopedIdentity(user, res) {
  if (user.role === 'CONTRACTOR' && !user.contractor_id) {
    res.status(403).json({ ok: false, error: 'Access denied: user has no assigned contractor' });
    return false;
  }
  if (user.role === 'GVMC_EE' && !user.zone_id) {
    res.status(403).json({ ok: false, error: 'Access denied: user has no assigned zone' });
    return false;
  }
  return true;
}

function contractorScope(user, params, conditions, startIndex) {
  let idx = startIndex;
  if (user.role === 'CONTRACTOR') {
    conditions.push(`c.contractor_id = $${idx++}`);
    params.push(user.contractor_id);
  } else if (user.role === 'GVMC_EE') {
    conditions.push(`c.assigned_zone_id = $${idx++}`);
    params.push(user.zone_id);
  }
  return idx;
}

router.get('/summary', async (req, res) => {
  if (!assertScopedIdentity(req.user, res)) return;
  try {
    const params = [];
    const conditions = [];
    const next = contractorScope(req.user, params, conditions, 1);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await db.manyOrNone(`
      SELECT c.contractor_id, c.company_name, z.zone_name,
             c.target_glow_rate, c.active_crews_deployed,
             c.monthly_invoice_base, c.total_penalty_mtd,
             ROUND(COALESCE(
               100.0 * COUNT(wo.work_order_id) FILTER (
                 WHERE wo.resolved_timestamp IS NOT NULL
                   AND wo.sla_deadline IS NOT NULL
                   AND wo.resolved_timestamp <= wo.sla_deadline
               ) / NULLIF(COUNT(wo.work_order_id) FILTER (
                 WHERE wo.resolved_timestamp IS NOT NULL AND wo.sla_deadline IS NOT NULL
               ), 0), 100.0), 2) AS sla_compliance_pct,
             COUNT(wo.work_order_id) FILTER (WHERE wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED')) AS open_tickets,
             COUNT(wo.work_order_id) FILTER (WHERE wo.ticket_status = 'RESOLVED') AS resolved_tickets,
             COUNT(wo.work_order_id) FILTER (WHERE wo.ticket_status = 'SLA_VIOLATED') AS sla_violations,
             ROUND(AVG(EXTRACT(EPOCH FROM (wo.resolved_timestamp - wo.reported_timestamp))/3600.0)
               FILTER (WHERE wo.resolved_timestamp IS NOT NULL), 2) AS avg_resolution_hours,
             COUNT(wo.work_order_id) FILTER (WHERE wo.penalty_deducted > 0) AS penalized_orders
      FROM contractors c
      LEFT JOIN zones z ON z.zone_id = c.assigned_zone_id
      LEFT JOIN work_orders wo
        ON wo.contractor_id = c.contractor_id
       AND wo.reported_timestamp >= date_trunc('month', NOW())
      ${where}
      GROUP BY c.contractor_id, c.company_name, z.zone_name,
               c.target_glow_rate, c.active_crews_deployed,
               c.monthly_invoice_base, c.total_penalty_mtd
      ORDER BY sla_compliance_pct ASC NULLS LAST, c.company_name
    `, params.slice(0, next - 1));

    res.json({ ok: true, generated_at: new Date().toISOString(), data: rows });
  } catch (err) {
    logger.error('Contractor performance summary error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.get('/:id/history', async (req, res) => {
  if (!assertScopedIdentity(req.user, res)) return;
  const contractorId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(contractorId)) return res.status(400).json({ ok: false, error: 'Invalid contractor id' });
  if (req.user.role === 'CONTRACTOR' && contractorId !== req.user.contractor_id) {
    return res.status(403).json({ ok: false, error: 'Access denied' });
  }

  try {
    const contractor = await db.oneOrNone(
      'SELECT contractor_id, company_name, assigned_zone_id FROM contractors WHERE contractor_id = $1',
      [contractorId]
    );
    if (!contractor) return res.status(404).json({ ok: false, error: 'Contractor not found' });
    if (req.user.role === 'GVMC_EE' && contractor.assigned_zone_id !== req.user.zone_id) {
      return res.status(403).json({ ok: false, error: 'Access denied' });
    }

    const history = await db.manyOrNone(`
      SELECT date_trunc('month', wo.reported_timestamp)::date AS month,
             COUNT(*) AS total_orders,
             COUNT(*) FILTER (WHERE wo.ticket_status = 'RESOLVED') AS resolved_orders,
             COUNT(*) FILTER (WHERE wo.ticket_status = 'SLA_VIOLATED') AS sla_violations,
             COUNT(*) FILTER (WHERE wo.penalty_deducted > 0) AS penalized_orders,
             COALESCE(SUM(wo.penalty_deducted), 0) AS penalties_inr,
             ROUND(AVG(EXTRACT(EPOCH FROM (wo.resolved_timestamp - wo.reported_timestamp))/3600.0)
               FILTER (WHERE wo.resolved_timestamp IS NOT NULL), 2) AS avg_resolution_hours,
             ROUND(COALESCE(
               100.0 * COUNT(*) FILTER (
                 WHERE wo.resolved_timestamp IS NOT NULL AND wo.sla_deadline IS NOT NULL
                   AND wo.resolved_timestamp <= wo.sla_deadline
               ) / NULLIF(COUNT(*) FILTER (
                 WHERE wo.resolved_timestamp IS NOT NULL AND wo.sla_deadline IS NOT NULL
               ), 0), 100.0), 2) AS sla_compliance_pct
      FROM work_orders wo
      WHERE wo.contractor_id = $1
      GROUP BY 1
      ORDER BY month DESC
      LIMIT 24
    `, [contractorId]);

    res.json({ ok: true, contractor, history });
  } catch (err) {
    logger.error('Contractor performance history error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

module.exports = router;
