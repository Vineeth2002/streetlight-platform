'use strict';

const express = require('express');
const db = require('../../config/database');
const logger = require('../utils/logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','CONTRACTOR','FIELD_ENGINEER','READ_ONLY'));

function scope(params, conditions, user, alias='v') {
  if (user.role === 'GVMC_EE') {
    params.push(user.zone_id); conditions.push(`${alias}.zone_id=$${params.length}`);
  } else if (user.role === 'CONTRACTOR') {
    params.push(user.contractor_id);
    conditions.push(`EXISTS (SELECT 1 FROM work_orders wo2 JOIN poles p2 ON p2.pole_id=wo2.pole_id WHERE p2.pole_id IN (SELECT pole_id FROM poles WHERE pole_id=p2.pole_id) AND wo2.contractor_id=$${params.length})`);
  } else if (user.role === 'FIELD_ENGINEER') {
    params.push(user.user_id);
    conditions.push(`EXISTS (SELECT 1 FROM work_orders wo3 WHERE wo3.pole_id IN (SELECT p3.pole_id FROM poles p3 WHERE p3.pole_id IN (SELECT p4.pole_id FROM poles p4)) AND wo3.assigned_to=$${params.length})`);
  }
}

router.get('/hotspots', async (req,res) => {
  try {
    const params=[],conditions=[];
    if(req.user.role==='GVMC_EE'){params.push(req.user.zone_id);conditions.push(`v.zone_id=$${params.length}`);}
    if(req.user.role==='CONTRACTOR'){
      params.push(req.user.contractor_id);
      conditions.push(`EXISTS (SELECT 1 FROM work_orders wo JOIN poles pp ON pp.pole_id=wo.pole_id JOIN junction_boxes jj ON jj.cabinet_id=pp.cabinet_id JOIN wards ww ON ww.ward_id=jj.ward_id WHERE ww.zone_id=v.zone_id AND wo.contractor_id=$${params.length})`);
    }
    if(req.user.role==='FIELD_ENGINEER'){
      params.push(req.user.user_id);
      conditions.push(`EXISTS (SELECT 1 FROM work_orders wo JOIN poles pp ON pp.pole_id=wo.pole_id JOIN junction_boxes jj ON jj.cabinet_id=pp.cabinet_id JOIN wards ww ON ww.ward_id=jj.ward_id WHERE ww.zone_id=v.zone_id AND wo.assigned_to=$${params.length})`);
    }
    const band=req.query.band;
    if(band){if(!['LOW','MEDIUM','HIGH','CRITICAL'].includes(band))return res.status(400).json({ok:false,error:'Invalid hotspot band'});params.push(band);conditions.push(`v.hotspot_band=$${params.length}`);}
    const where=conditions.length?`WHERE ${conditions.join(' AND ')}`:'';
    const data=await db.manyOrNone(`SELECT ST_AsGeoJSON(centroid)::json AS centroid,zone_id,zone_name,ward_id,ward_number,asset_count,failures_90d,open_work_orders,sla_violations_90d,faulty_assets,no_signal_assets,hotspot_band FROM v_spatial_failure_hotspots v ${where} ORDER BY CASE hotspot_band WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,failures_90d DESC LIMIT 2000`,params);
    res.json({ok:true,advisory:true,generated_at:new Date().toISOString(),data});
  } catch(err){logger.error('Spatial hotspots error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

router.get('/roads', async (req,res) => {
  try {
    const params=[],conditions=[];
    if(req.user.role==='GVMC_EE'){params.push(req.user.zone_id);conditions.push(`v.zone_id=$${params.length}`);}
    if(req.user.role==='CONTRACTOR'){params.push(req.user.contractor_id);conditions.push(`EXISTS (SELECT 1 FROM work_orders wo JOIN poles pp ON pp.pole_id=wo.pole_id JOIN junction_boxes jj ON jj.cabinet_id=pp.cabinet_id JOIN wards ww ON ww.ward_id=jj.ward_id WHERE ww.zone_id=v.zone_id AND wo.contractor_id=$${params.length})`);}
    if(req.user.role==='FIELD_ENGINEER'){params.push(req.user.user_id);conditions.push(`EXISTS (SELECT 1 FROM work_orders wo JOIN poles pp ON pp.pole_id=wo.pole_id JOIN junction_boxes jj ON jj.cabinet_id=pp.cabinet_id JOIN wards ww ON ww.ward_id=jj.ward_id WHERE ww.zone_id=v.zone_id AND wo.assigned_to=$${params.length})`);}
    const where=conditions.length?`WHERE ${conditions.join(' AND ')}`:'';
    const data=await db.manyOrNone(`SELECT zone_id,zone_name,ward_id,ward_number,road_name,asset_count,failures_90d,open_work_orders,sla_violations_90d,faulty_assets FROM v_spatial_road_intelligence v ${where} ORDER BY failures_90d DESC,open_work_orders DESC LIMIT 2000`,params);
    res.json({ok:true,advisory:true,data});
  } catch(err){logger.error('Spatial road intelligence error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

module.exports=router;
