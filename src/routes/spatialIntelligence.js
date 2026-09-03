'use strict';

const express = require('express');
const db = require('../../config/database');
const logger = require('../utils/logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','READ_ONLY'));

function assertScopedIdentity(user, res) {
  if (user.role === 'GVMC_EE' && !user.zone_id) {
    res.status(403).json({ ok:false, error:'Access denied: user has no assigned zone' });
    return false;
  }
  return true;
}

function zoneScope(req, params, conditions, alias='v') {
  if (req.user.role === 'GVMC_EE') {
    params.push(req.user.zone_id);
    conditions.push(`${alias}.zone_id=$${params.length}`);
  }
}

router.get('/hotspots', async (req,res) => {
  if (!assertScopedIdentity(req.user, res)) return;
  try {
    const params=[],conditions=[];
    zoneScope(req,params,conditions);
    const band=req.query.band;
    if(band){
      if(!['LOW','MEDIUM','HIGH','CRITICAL'].includes(band)) return res.status(400).json({ok:false,error:'Invalid hotspot band'});
      params.push(band); conditions.push(`v.hotspot_band=$${params.length}`);
    }
    const where=conditions.length?`WHERE ${conditions.join(' AND ')}`:'';
    const data=await db.manyOrNone(`SELECT ST_AsGeoJSON(centroid)::json AS centroid,zone_id,zone_name,ward_id,ward_number,asset_count,failures_90d,open_work_orders,sla_violations_90d,faulty_assets,no_signal_assets,hotspot_band FROM v_spatial_failure_hotspots v ${where} ORDER BY CASE hotspot_band WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,failures_90d DESC LIMIT 2000`,params);
    res.json({ok:true,advisory:true,generated_at:new Date().toISOString(),data});
  } catch(err){logger.error('Spatial hotspots error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

router.get('/roads', async (req,res) => {
  if (!assertScopedIdentity(req.user, res)) return;
  try {
    const params=[],conditions=[];
    zoneScope(req,params,conditions);
    const where=conditions.length?`WHERE ${conditions.join(' AND ')}`:'';
    const data=await db.manyOrNone(`SELECT zone_id,zone_name,ward_id,ward_number,road_name,asset_count,failures_90d,open_work_orders,sla_violations_90d,faulty_assets FROM v_spatial_road_intelligence v ${where} ORDER BY failures_90d DESC,open_work_orders DESC LIMIT 2000`,params);
    res.json({ok:true,advisory:true,data});
  } catch(err){logger.error('Spatial road intelligence error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

module.exports=router;
