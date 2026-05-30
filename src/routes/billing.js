const express = require('express');
const router  = express.Router();
const db      = require('../../config/database');
const logger  = require('../utils/logger');
const { runMonthlyBillingAudit, calcPenaltyA, calcPenaltyB } = require('../services/slaBillingService');

router.post('/audit', async (req, res) => {
  try {
    const report = await runMonthlyBillingAudit({ dryRun:false });
    res.json({ ok:true, report });
  } catch(err) { res.status(500).json({ ok:false, error:err.message }); }
});

router.post('/audit/dry-run', async (req, res) => {
  try {
    const report = await runMonthlyBillingAudit({ dryRun:true });
    res.json({ ok:true, dry_run:true, report });
  } catch(err) { res.status(500).json({ ok:false, error:err.message }); }
});

router.get('/penalties', async (req, res) => {
  try {
    const rows = await db.manyOrNone(`
      SELECT wo.work_order_id, wo.fault_category, wo.reported_timestamp,
             wo.sla_deadline, wo.days_overdue, wo.penalty_deducted, wo.penalty_type,
             p.pole_number, p.luminaire_wattage,
             c.company_name AS contractor_name, z.zone_name
      FROM work_orders wo
      JOIN poles p ON wo.pole_id=p.pole_id
      JOIN junction_boxes jb ON p.cabinet_id=jb.cabinet_id
      JOIN wards w ON jb.ward_id=w.ward_id
      JOIN zones z ON w.zone_id=z.zone_id
      LEFT JOIN contractors c ON wo.contractor_id=c.contractor_id
      WHERE wo.penalty_deducted>0
        AND wo.reported_timestamp >= date_trunc('month',NOW())
      ORDER BY wo.penalty_deducted DESC
    `);
    const total = rows.reduce((s,r) => s+parseFloat(r.penalty_deducted),0);
    res.json({ ok:true, count:rows.length, total_penalties_inr:total.toFixed(2), data:rows });
  } catch(err) { res.status(500).json({ ok:false, error:'Internal server error' }); }
});

router.get('/summary', async (req, res) => {
  try {
    const summary = await db.manyOrNone(`
      SELECT z.zone_name, c.company_name AS contractor_name,
             c.monthly_invoice_base, c.total_penalty_mtd,
             ROUND(c.monthly_invoice_base-c.total_penalty_mtd,2) AS net_payable,
             ROUND(c.total_penalty_mtd/NULLIF(c.monthly_invoice_base,0)*100,2) AS penalty_pct
      FROM contractors c
      LEFT JOIN zones z ON c.assigned_zone_id=z.zone_id
      ORDER BY c.total_penalty_mtd DESC
    `);
    res.json({ ok:true, by_contractor:summary });
  } catch(err) { res.status(500).json({ ok:false, error:'Internal server error' }); }
});

router.post('/reset-counters', async (req, res) => {
  try {
    await db.none(`UPDATE contractors SET total_penalty_mtd=0, total_solved_daily=0`);
    res.json({ ok:true, message:'Monthly counters reset' });
  } catch(err) { res.status(500).json({ ok:false, error:'Internal server error' }); }
});

router.get('/simulate', (req, res) => {
  const w=parseInt(req.query.wattage||70);
  const d=parseInt(req.query.days_overdue||3);
  const u=parseInt(req.query.unresolved_poles||10);
  const a=calcPenaltyA(w,d), b=calcPenaltyB(d,u);
  res.json({
    ok:true,
    inputs:{ wattage:w, days_overdue:d, unresolved_poles:u },
    penalty_a_energy_inr:   a.toFixed(2),
    penalty_b_demurrage_inr: b.toFixed(2),
    applied_penalty: a>=b ? 'ENERGY' : 'DEMURRAGE',
    final_penalty_inr: Math.max(a,b).toFixed(2),
  });
});

module.exports = router;