'use strict';

const express = require('express');
const db = require('../../config/database');
const logger = require('../utils/logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('SUPER_ADMIN', 'GVMC_COMMISSIONER', 'GVMC_EE', 'FIELD_ENGINEER', 'CONTRACTOR', 'READ_ONLY'));

router.get('/:poleId', async (req, res) => {
  const poleId = Number(req.params.poleId);
  if (!Number.isInteger(poleId) || poleId < 1) return res.status(400).json({ok:false,error:'Invalid pole ID'});

  try {
    const pole = await db.oneOrNone(`
      SELECT p.pole_id, p.pole_number, p.node_id, p.current_status, p.road_name,
             p.luminaire_wattage, p.geolocation,
             ST_Y(p.geolocation)::float8 AS latitude,
             ST_X(p.geolocation)::float8 AS longitude,
             jb.cabinet_id, jb.cabinet_serial_no, jb.nominal_voltage,
             w.ward_id, w.ward_number, z.zone_id, z.zone_name
      FROM poles p
      LEFT JOIN junction_boxes jb ON jb.cabinet_id=p.cabinet_id
      LEFT JOIN wards w ON w.ward_id=jb.ward_id
      LEFT JOIN zones z ON z.zone_id=w.zone_id
      WHERE p.pole_id=$1`, [poleId]);
    if (!pole) return res.status(404).json({ok:false,error:'Pole not found'});

    const [telemetry, episodes, incidents, workOrders] = await Promise.all([
      db.manyOrNone(`SELECT timestamp,pole_number,node_id,voltage_rms,current_rms,active_power,power_factor,temperature,rssi FROM node_telemetry WHERE pole_number=$1 ORDER BY timestamp DESC LIMIT 50`, [pole.pole_number]),
      db.manyOrNone(`SELECT episode_id,fault_category,status,first_detected_at,last_observed_at,recovered_at,closed_at,incident_id,work_order_id,detection_source,metadata FROM fault_episodes WHERE pole_id=$1 ORDER BY first_detected_at DESC LIMIT 50`, [poleId]),
      db.manyOrNone(`SELECT i.incident_id,i.incident_number,i.incident_type,i.severity,i.status,i.source,i.detected_at,i.summary,i.recommendation,i.primary_asset_id FROM incidents i WHERE i.primary_asset_id=$1 ORDER BY i.detected_at DESC LIMIT 50`, [poleId]),
      db.manyOrNone(`SELECT wo.work_order_id,wo.contractor_id,wo.fault_category,wo.fault_description,wo.reported_by,wo.reported_timestamp,wo.assigned_timestamp,wo.resolved_timestamp,wo.sla_deadline,wo.ticket_status,wo.resolution_notes,wo.penalty_deducted,wo.penalty_type,wo.days_overdue,wo.incident_id,c.company_name AS contractor_name FROM work_orders wo LEFT JOIN contractors c ON c.contractor_id=wo.contractor_id WHERE wo.pole_id=$1 ORDER BY wo.reported_timestamp DESC LIMIT 50`, [poleId]),
    ]);

    const openEpisode = episodes.find(x=>x.status==='OPEN') || null;
    const activeWorkOrder = workOrders.find(x=>!['RESOLVED','CANCELLED'].includes(x.ticket_status)) || null;
    const activeIncident = incidents.find(x=>!['CLOSED','CANCELLED'].includes(x.status)) || null;
    const sla = activeWorkOrder?.sla_deadline ? {
      deadline: activeWorkOrder.sla_deadline,
      hours_remaining: (new Date(activeWorkOrder.sla_deadline).getTime()-Date.now())/3600000,
      breached: new Date(activeWorkOrder.sla_deadline).getTime() < Date.now(),
      penalty_deducted: Number(activeWorkOrder.penalty_deducted||0),
      penalty_type: activeWorkOrder.penalty_type,
    } : null;

    res.json({ok:true,generated_at:new Date().toISOString(),asset:{...pole,geolocation:undefined},current:{status:pole.current_status,open_episode:openEpisode,active_incident:activeIncident,active_work_order:activeWorkOrder,sla},telemetry,episodes,incidents,work_orders:workOrders});
  } catch (err) {
    logger.error('Asset detail error',{poleId,error:err.message});
    res.status(500).json({ok:false,error:'Internal server error'});
  }
});

module.exports = router;
