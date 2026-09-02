const express  = require('express');
const router   = express.Router();
const db       = require('../../config/database');
const logger   = require('../utils/logger');
const { runMonthlyBillingAudit, calcPenaltyA, calcPenaltyB } = require('../services/slaBillingService');
const { sendMonthlyReport, generateReportPreview }           = require('../services/reportService');
const { requireAuth, requireRole }                           = require('../middleware/auth');

// ─── Protect ALL billing routes ───────────────────────────────────────────────
router.use(requireAuth);

// ─── POST /api/v1/billing/audit ───────────────────────────────────────────────
router.post('/audit', requireRole('SUPER_ADMIN'), async (req, res) => {
  try {
    const report = await runMonthlyBillingAudit({ dryRun: false });
    res.json({ ok: true, report });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/v1/billing/audit/dry-run ──────────────────────────────────────
router.post('/audit/dry-run', requireRole('SUPER_ADMIN', 'GVMC_COMMISSIONER'), async (req, res) => {
  try {
    const report = await runMonthlyBillingAudit({ dryRun: true });
    res.json({ ok: true, dry_run: true, report });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /api/v1/billing/penalties ───────────────────────────────────────────
router.get('/penalties', requireRole('SUPER_ADMIN', 'GVMC_COMMISSIONER', 'GVMC_EE'), async (req, res) => {
  try {
    const zoneId = req.user.role === 'GVMC_EE' ? req.user.zone_id : null;

    if (req.user.role === 'GVMC_EE' && !zoneId) {
      return res.status(403).json({ ok: false, error: 'No zone assigned to user' });
    }

    const rows = await db.manyOrNone(`
      SELECT wo.work_order_id, wo.fault_category, wo.reported_timestamp,
             wo.sla_deadline, wo.days_overdue, wo.penalty_deducted, wo.penalty_type,
             p.pole_number, p.luminaire_wattage,
             c.company_name AS contractor_name, z.zone_name
      FROM work_orders wo
      JOIN poles p ON wo.pole_id = p.pole_id
      JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id
      JOIN wards w ON jb.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      LEFT JOIN contractors c ON wo.contractor_id = c.contractor_id
      WHERE wo.penalty_deducted > 0
        AND wo.reported_timestamp >= date_trunc('month', NOW())
        AND ($1::int IS NULL OR w.zone_id = $1)
      ORDER BY wo.penalty_deducted DESC
    `, [zoneId]);
    const total = rows.reduce((s, r) => s + parseFloat(r.penalty_deducted), 0);
    res.json({ ok: true, count: rows.length, total_penalties_inr: total.toFixed(2), data: rows });
  } catch (err) {
    logger.error('Penalties fetch error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── GET /api/v1/billing/summary ─────────────────────────────────────────────
router.get('/summary', requireRole('SUPER_ADMIN', 'GVMC_COMMISSIONER', 'GVMC_EE'), async (req, res) => {
  try {
    const zoneId = req.user.role === 'GVMC_EE' ? req.user.zone_id : null;

    if (req.user.role === 'GVMC_EE' && !zoneId) {
      return res.status(403).json({ ok: false, error: 'No zone assigned to user' });
    }

    const summary = await db.manyOrNone(`
      SELECT z.zone_name, c.company_name AS contractor_name,
             c.monthly_invoice_base, c.total_penalty_mtd,
             ROUND(c.monthly_invoice_base - c.total_penalty_mtd, 2) AS net_payable,
             ROUND(c.total_penalty_mtd / NULLIF(c.monthly_invoice_base, 0) * 100, 2) AS penalty_pct
      FROM contractors c
      LEFT JOIN zones z ON c.assigned_zone_id = z.zone_id
      WHERE ($1::int IS NULL OR c.assigned_zone_id = $1)
      ORDER BY c.total_penalty_mtd DESC
    `, [zoneId]);
    res.json({ ok: true, by_contractor: summary });
  } catch (err) {
    logger.error('Billing summary error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── POST /api/v1/billing/reset-counters ─────────────────────────────────────
router.post('/reset-counters', requireRole('SUPER_ADMIN'), async (req, res) => {
  try {
    await db.none(`UPDATE contractors SET total_penalty_mtd = 0, total_solved_daily = 0`);
    logger.warn('Monthly counters reset manually', { by: req.user.user_id });
    res.json({ ok: true, message: 'Monthly counters reset' });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── GET /api/v1/billing/simulate ────────────────────────────────────────────
router.get('/simulate', (req, res) => {
  const w = parseInt(req.query.wattage       || 70);
  const d = parseInt(req.query.days_overdue  || 3);
  const u = parseInt(req.query.unresolved_poles || 10);
  const a = calcPenaltyA(w, d);
  const b = calcPenaltyB(d, u);
  res.json({
    ok: true,
    inputs: { wattage: w, days_overdue: d, unresolved_poles: u },
    penalty_a_energy_inr:    a.toFixed(2),
    penalty_b_demurrage_inr: b.toFixed(2),
    applied_penalty:         a >= b ? 'ENERGY' : 'DEMURRAGE',
    final_penalty_inr:       Math.max(a, b).toFixed(2),
  });
});

// ─── GET /api/v1/billing/report/preview ──────────────────────────────────────
router.get('/report/preview',
  requireRole('SUPER_ADMIN', 'GVMC_COMMISSIONER'),
  async (req, res) => {
    try {
      const html = await generateReportPreview();
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (err) {
      logger.error('Report preview error', { error: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ─── POST /api/v1/billing/report/send ────────────────────────────────────────
router.post('/report/send',
  requireRole('SUPER_ADMIN'),
  async (req, res) => {
    try {
      const result = await sendMonthlyReport();
      res.json(result);
    } catch (err) {
      logger.error('Report send error', { error: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

module.exports = router;