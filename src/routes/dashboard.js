'use strict';

const express = require('express');
const db = require('../../config/database');
const logger = require('../utils/logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('SUPER_ADMIN', 'GVMC_COMMISSIONER', 'GVMC_EE', 'READ_ONLY'));

router.get('/summary', async (req, res) => {
  try {
    const [city, zones, incidents, workOrders, sla, penalties, assets] = await Promise.all([
      db.one(`SELECT COUNT(*) FILTER (WHERE current_status <> 'DECOMMISSIONED')::int AS total_poles,
                     COUNT(*) FILTER (WHERE current_status = 'OPERATIONAL')::int AS operational_poles,
                     COUNT(*) FILTER (WHERE current_status = 'FAULTY')::int AS faulty_poles,
                     COUNT(*) FILTER (WHERE current_status = 'UNDER_REPAIR')::int AS under_repair_poles,
                     COUNT(*) FILTER (WHERE current_status = 'NO_SIGNAL')::int AS no_signal_poles,
                     COUNT(*) FILTER (WHERE current_status = 'DAY_BURN')::int AS day_burn_poles
              FROM poles`),
      db.manyOrNone(`SELECT zone_id, zone_name, total_poles, operational_poles,
                            glow_rate_pct, faulty_poles, day_burn_poles
                     FROM v_zone_glow_rates ORDER BY glow_rate_pct ASC NULLS LAST, zone_name`),
      db.manyOrNone(`SELECT i.incident_id, i.incident_number, i.incident_type, i.severity,
                            i.status, i.source, i.primary_asset_id, p.pole_number,
                            i.detected_at, i.summary, i.recommendation,
                            z.zone_name, w.ward_number
                     FROM incidents i
                     LEFT JOIN poles p ON p.pole_id = i.primary_asset_id
                     LEFT JOIN junction_boxes jb ON jb.cabinet_id = p.cabinet_id
                     LEFT JOIN wards w ON w.ward_id = jb.ward_id
                     LEFT JOIN zones z ON z.zone_id = w.zone_id
                     WHERE i.status NOT IN ('CLOSED','CANCELLED')
                     ORDER BY CASE i.severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
                              i.detected_at DESC LIMIT 200`),
      db.manyOrNone(`SELECT wo.work_order_id, wo.pole_id, wo.contractor_id,
                            wo.fault_category, wo.fault_description, wo.reported_by,
                            wo.reported_timestamp, wo.assigned_timestamp, wo.resolved_timestamp,
                            wo.sla_deadline, wo.ticket_status, wo.penalty_deducted,
                            wo.penalty_type, wo.days_overdue, wo.incident_id,
                            p.pole_number, c.company_name AS contractor_name,
                            z.zone_name, w.ward_number
                     FROM work_orders wo
                     JOIN poles p ON p.pole_id = wo.pole_id
                     JOIN junction_boxes jb ON jb.cabinet_id = p.cabinet_id
                     JOIN wards w ON w.ward_id = jb.ward_id
                     JOIN zones z ON z.zone_id = w.zone_id
                     LEFT JOIN contractors c ON c.contractor_id = wo.contractor_id
                     WHERE wo.ticket_status NOT IN ('CANCELLED')
                     ORDER BY wo.reported_timestamp DESC LIMIT 200`),
      db.manyOrNone(`SELECT wo.work_order_id, wo.sla_deadline, wo.ticket_status,
                            EXTRACT(EPOCH FROM (wo.sla_deadline - NOW())) / 3600.0 AS hours_remaining,
                            GREATEST(0, EXTRACT(EPOCH FROM (NOW() - wo.sla_deadline)) / 3600.0) AS hours_overdue,
                            p.pole_number, z.zone_name, c.company_name AS contractor_name
                     FROM work_orders wo
                     JOIN poles p ON p.pole_id = wo.pole_id
                     JOIN junction_boxes jb ON jb.cabinet_id = p.cabinet_id
                     JOIN wards w ON w.ward_id = jb.ward_id
                     JOIN zones z ON z.zone_id = w.zone_id
                     LEFT JOIN contractors c ON c.contractor_id = wo.contractor_id
                     WHERE wo.sla_deadline IS NOT NULL
                       AND wo.ticket_status NOT IN ('RESOLVED','CANCELLED')
                     ORDER BY wo.sla_deadline ASC LIMIT 200`),
      db.one(`SELECT COALESCE(SUM(total_penalty_mtd),0) AS penalty_mtd_inr FROM contractors`),
      db.manyOrNone(`SELECT p.pole_id, p.pole_number, p.node_id, p.current_status,
                            ST_Y(p.geolocation)::float8 AS latitude,
                            ST_X(p.geolocation)::float8 AS longitude,
                            p.road_name, p.luminaire_wattage,
                            jb.cabinet_id, jb.cabinet_serial_no, jb.nominal_voltage,
                            w.ward_number, z.zone_id, z.zone_name
                     FROM poles p
                     JOIN junction_boxes jb ON jb.cabinet_id = p.cabinet_id
                     JOIN wards w ON w.ward_id = jb.ward_id
                     JOIN zones z ON z.zone_id = w.zone_id
                     WHERE p.current_status <> 'DECOMMISSIONED'
                     ORDER BY p.pole_id LIMIT 5000`),
    ]);

    const total = Number(city.total_poles || 0);
    const operational = Number(city.operational_poles || 0);
    const glowRatePct = total ? Number((operational / total * 100).toFixed(2)) : 0;
    const slaBreaches = sla.filter(x => Number(x.hours_overdue) > 0).length;

    res.json({
      ok: true,
      generated_at: new Date().toISOString(),
      city: {
        total_poles: total,
        operational_poles: operational,
        faulty_poles: Number(city.faulty_poles || 0),
        under_repair_poles: Number(city.under_repair_poles || 0),
        no_signal_poles: Number(city.no_signal_poles || 0),
        day_burn_poles: Number(city.day_burn_poles || 0),
        glow_rate_pct: glowRatePct,
        sla_breaches: slaBreaches,
        penalty_mtd_inr: Number(penalties.penalty_mtd_inr || 0),
        open_incidents: incidents.length,
        open_work_orders: workOrders.filter(x => !['RESOLVED','CANCELLED'].includes(x.ticket_status)).length,
      },
      zones,
      incidents,
      work_orders: workOrders,
      sla,
      assets,
    });
  } catch (err) {
    logger.error('Dashboard summary error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.get('/zones', async (req, res) => {
  try {
    const zones = await db.manyOrNone(`SELECT zone_id, zone_name, total_poles, operational_poles,
                                              glow_rate_pct, faulty_poles, day_burn_poles
                                       FROM v_zone_glow_rates
                                       ORDER BY zone_name`);
    res.json({ ok: true, generated_at: new Date().toISOString(), zones });
  } catch (err) {
    logger.error('Dashboard zones error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

module.exports = router;
