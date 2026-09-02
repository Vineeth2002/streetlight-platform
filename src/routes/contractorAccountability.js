'use strict';

const express = require('express');
const db = require('../../config/database');
const logger = require('../utils/logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('SUPER_ADMIN', 'GVMC_COMMISSIONER', 'GVMC_EE', 'CONTRACTOR', 'READ_ONLY'));

router.get('/', async (req, res) => {
  try {
    const params = [];
    const conditions = [];
    if (req.user.role === 'CONTRACTOR') {
      conditions.push(`contractor_id = $1`);
      params.push(req.user.contractor_id);
    } else if (req.user.role === 'GVMC_EE') {
      conditions.push(`assigned_zone_id = $1`);
      params.push(req.user.zone_id);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await db.manyOrNone(`
      SELECT contractor_id, company_name, assigned_zone_id, zone_name,
             target_glow_rate, active_crews_deployed, monthly_invoice_base,
             total_penalty_mtd, orders_90d, resolved_90d, sla_violations_90d,
             penalized_orders_90d, repeat_failure_orders_90d,
             evidence_backed_resolutions, open_orders, avg_resolution_hours,
             ROUND(COALESCE(100.0 * resolved_90d / NULLIF(orders_90d, 0), 0), 2) AS resolution_rate_90d_pct,
             ROUND(COALESCE(100.0 * evidence_backed_resolutions / NULLIF(resolved_90d, 0), 0), 2) AS evidence_coverage_pct
      FROM v_contractor_accountability
      ${where}
      ORDER BY sla_violations_90d DESC, repeat_failure_orders_90d DESC, company_name
    `, params);

    res.json({ ok: true, generated_at: new Date().toISOString(), window_days: 90, data: rows });
  } catch (err) {
    logger.error('Contractor accountability error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

module.exports = router;
