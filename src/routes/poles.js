const express = require('express');
const router  = express.Router();
const db      = require('../../config/database');
const logger  = require('../utils/logger');

router.get('/zones', async (req, res) => {
  try {
    const zones = await db.manyOrNone('SELECT * FROM v_zone_glow_rates');
    res.json({ ok:true, city_total_poles:200000, zones });
  } catch(err) { res.status(500).json({ ok:false, error:'Internal server error' }); }
});

router.get('/contractors', async (req, res) => {
  try {
    const rows = await db.manyOrNone('SELECT * FROM v_contractor_kpis');
    res.json({ ok:true, contractors:rows });
  } catch(err) { res.status(500).json({ ok:false, error:'Internal server error' }); }
});

router.get('/contractors/:id/report', async (req, res) => {
  try {
    const contractor = await db.oneOrNone(`
      SELECT c.*, z.zone_name FROM contractors c
      LEFT JOIN zones z ON c.assigned_zone_id=z.zone_id WHERE c.contractor_id=$1
    `, [req.params.id]);
    if (!contractor) return res.status(404).json({ ok:false, error:'Contractor not found' });

    const penalizedOrders = await db.manyOrNone(`
      SELECT wo.work_order_id, wo.fault_category, wo.reported_timestamp,
             wo.sla_deadline, wo.days_overdue, wo.penalty_deducted, wo.penalty_type,
             p.pole_number, p.luminaire_wattage
      FROM work_orders wo JOIN poles p ON wo.pole_id=p.pole_id
      WHERE wo.contractor_id=$1 AND wo.penalty_deducted>0
        AND wo.reported_timestamp >= date_trunc('month',NOW())
      ORDER BY wo.penalty_deducted DESC
    `, [req.params.id]);

    const netPayable = parseFloat(contractor.monthly_invoice_base) - parseFloat(contractor.total_penalty_mtd);
    res.json({ ok:true, contractor:{ ...contractor, net_payable_inr:netPayable.toFixed(2) }, penalized_orders:penalizedOrders });
  } catch(err) { res.status(500).json({ ok:false, error:'Internal server error' }); }
});

router.get('/nearby', async (req, res) => {
  const { lat, lng, radius=500 } = req.query;
  if (!lat || !lng) return res.status(400).json({ ok:false, error:'lat and lng required' });
  try {
    const rows = await db.manyOrNone(`
      SELECT p.pole_id, p.pole_number, p.current_status, p.luminaire_wattage,
             ST_AsGeoJSON(p.geolocation)::json AS geolocation,
             ROUND(ST_Distance(
               p.geolocation::geography,
               ST_SetSRID(ST_MakePoint($2,$1),4326)::geography
             )::numeric,1) AS distance_m
      FROM poles p
      WHERE ST_DWithin(
        p.geolocation::geography,
        ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, $3
      )
      ORDER BY distance_m LIMIT 200
    `, [parseFloat(lat), parseFloat(lng), parseFloat(radius)]);
    res.json({ ok:true, count:rows.length, poles:rows });
  } catch(err) { res.status(500).json({ ok:false, error:'Internal server error' }); }
});

router.get('/', async (req, res) => {
  const { status, zone_id, page=1, limit=100 } = req.query;
  const offset = (parseInt(page)-1)*parseInt(limit);
  const params=[], where=[];
  if (status)  { params.push(status);  where.push(`p.current_status=$${params.length}`); }
  if (zone_id) { params.push(zone_id); where.push(`z.zone_id=$${params.length}`); }
  const whereClause = where.length ? 'WHERE '+where.join(' AND ') : '';

  try {
    params.push(parseInt(limit), offset);
    const rows = await db.manyOrNone(`
      SELECT p.pole_id, p.pole_number, p.wiring_type, p.luminaire_wattage,
             p.current_status, p.road_name,
             ST_AsGeoJSON(p.geolocation)::json AS geolocation,
             w.ward_number, w.secretariat_code, z.zone_name
      FROM poles p
      JOIN junction_boxes jb ON p.cabinet_id=jb.cabinet_id
      JOIN wards w ON jb.ward_id=w.ward_id
      JOIN zones z ON w.zone_id=z.zone_id
      ${whereClause}
      ORDER BY p.pole_number
      LIMIT $${params.length-1} OFFSET $${params.length}
    `, params);
    res.json({ ok:true, count:rows.length, data:rows });
  } catch(err) { res.status(500).json({ ok:false, error:'Internal server error' }); }
});

router.get('/:id', async (req, res) => {
  try {
    const pole = await db.oneOrNone(`
      SELECT p.*, ST_AsGeoJSON(p.geolocation)::json AS geolocation,
             jb.cabinet_serial_no, jb.contactor_status,
             w.ward_number, w.secretariat_code, w.ward_amenity_sec_name, w.ward_amenity_sec_phone,
             z.zone_name, z.zonal_commissioner, c.company_name AS contractor_name
      FROM poles p
      JOIN junction_boxes jb ON p.cabinet_id=jb.cabinet_id
      JOIN wards w ON jb.ward_id=w.ward_id
      JOIN zones z ON w.zone_id=z.zone_id
      LEFT JOIN contractors c ON c.assigned_zone_id=z.zone_id
      WHERE p.pole_id=$1
    `, [req.params.id]);
    if (!pole) return res.status(404).json({ ok:false, error:'Pole not found' });

    const telemetry = await db.manyOrNone(`
      SELECT timestamp, voltage_rms, current_rms, active_power, power_factor, temperature, rssi
      FROM node_telemetry WHERE pole_number=$1 ORDER BY timestamp DESC LIMIT 10
    `, [pole.pole_number]);

    const openOrders = await db.manyOrNone(`
      SELECT work_order_id, fault_category, reported_timestamp, sla_deadline, ticket_status
      FROM work_orders WHERE pole_id=$1 AND ticket_status NOT IN ('RESOLVED','CANCELLED')
    `, [pole.pole_id]);

    res.json({ ok:true, data:pole, telemetry, open_work_orders:openOrders });
  } catch(err) { res.status(500).json({ ok:false, error:'Internal server error' }); }
});

module.exports = router;