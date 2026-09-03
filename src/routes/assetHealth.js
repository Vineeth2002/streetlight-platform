'use strict';

const express = require('express');
const db = require('../../config/database');
const logger = require('../utils/logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','CONTRACTOR','FIELD_ENGINEER','READ_ONLY'));

function assertScopedIdentity(user, res) {
  if (user.role === 'GVMC_EE' && !user.zone_id) {
    res.status(403).json({ok:false,error:'Access denied: user has no assigned zone'});
    return false;
  }
  if (user.role === 'CONTRACTOR' && !user.contractor_id) {
    res.status(403).json({ok:false,error:'Access denied: user has no assigned contractor'});
    return false;
  }
  if (user.role === 'FIELD_ENGINEER' && !user.user_id) {
    res.status(403).json({ok:false,error:'Access denied: user identity is unavailable'});
    return false;
  }
  return true;
}

function applyScope(user, params, conditions) {
  if (user.role === 'GVMC_EE') {
    params.push(user.zone_id); conditions.push(`v.zone_id=$${params.length}`);
  } else if (user.role === 'CONTRACTOR') {
    params.push(user.contractor_id); conditions.push(`EXISTS (SELECT 1 FROM work_orders wo WHERE wo.pole_id=v.pole_id AND wo.contractor_id=$${params.length})`);
  } else if (user.role === 'FIELD_ENGINEER') {
    params.push(user.user_id); conditions.push(`EXISTS (SELECT 1 FROM work_orders wo WHERE wo.pole_id=v.pole_id AND wo.assigned_to=$${params.length})`);
  }
}

router.get('/summary', async (req,res) => {
  try {
    if (!assertScopedIdentity(req.user,res)) return;
    const params=[],conditions=[]; applyScope(req.user,params,conditions);
    const where=conditions.length?`WHERE ${conditions.join(' AND ')}`:'';
    const totals=await db.one(`SELECT COUNT(*)::int AS assets,ROUND(AVG(health_score),2) AS avg_health,COUNT(*) FILTER (WHERE health_band='EXCELLENT')::int AS excellent,COUNT(*) FILTER (WHERE health_band='GOOD')::int AS good,COUNT(*) FILTER (WHERE health_band='FAIR')::int AS fair,COUNT(*) FILTER (WHERE health_band='POOR')::int AS poor,COUNT(*) FILTER (WHERE health_band='CRITICAL')::int AS critical FROM v_asset_health_index v ${where}`,params);
    const data=await db.manyOrNone(`SELECT pole_id,pole_number,current_status,zone_id,zone_name,ward_id,ward_number,health_score,health_band,risk_score,risk_band,operational_component,maintenance_component,telemetry_component,warranty_component,repair_count_90d,repair_count_365d,recurrence_count_90d,open_work_orders,telemetry_at,last_failure_at,dominant_fault_category FROM v_asset_health_index v ${where} ORDER BY health_score ASC LIMIT 1000`,params);
    res.json({ok:true,advisory:true,generated_at:new Date().toISOString(),totals,data});
  } catch(err){logger.error('Asset health summary error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

router.get('/:poleId', async (req,res) => {
  const poleId=Number.parseInt(req.params.poleId,10);
  if(!Number.isInteger(poleId))return res.status(400).json({ok:false,error:'Invalid pole id'});
  try {
    if (!assertScopedIdentity(req.user,res)) return;
    const params=[poleId],conditions=['v.pole_id=$1']; applyScope(req.user,params,conditions);
    const row=await db.oneOrNone(`SELECT * FROM v_asset_health_index v WHERE ${conditions.join(' AND ')}` ,params);
    if(!row)return res.status(404).json({ok:false,error:'Asset not found or access denied'});
    const factors={operational_component:row.operational_component,reliability_component:Number((100-row.risk_score).toFixed(2)),maintenance_component:row.maintenance_component,telemetry_component:row.telemetry_component,warranty_component:row.warranty_component,open_work_order_penalty:Math.min(Number(row.open_work_orders||0)*5,20)};
    res.json({ok:true,advisory:true,asset:row,explanation:{formula:'30% operational + 30% reliability + 15% maintenance + 15% telemetry + 10% warranty − open-work-order penalty',factors}});
  } catch(err){logger.error('Asset health detail error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

module.exports=router;
