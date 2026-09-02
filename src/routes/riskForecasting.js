'use strict';
const express=require('express');
const db=require('../../config/database');
const logger=require('../utils/logger');
const {requireAuth,requireRole}=require('../middleware/auth');
const router=express.Router();
const READ=['SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','READ_ONLY'];
router.use(requireAuth,requireRole(...READ));
function scope(user,params,where,alias='v'){
  if(user.role==='GVMC_EE'){
    params.push(user.zone_id);
    where.push(`${alias}.zone_id=$${params.length}`);
  }
}
router.get('/assets',async(req,res)=>{
  try{
    const params=[],where=[];scope(req.user,params,where);
    if(req.query.exposure){if(!['LOW_EXPOSURE','MEDIUM_EXPOSURE','HIGH_EXPOSURE','CRITICAL_EXPOSURE'].includes(req.query.exposure))return res.status(400).json({ok:false,error:'Invalid forecast exposure'});params.push(req.query.exposure);where.push(`v.forecast_30d_exposure=$${params.length}`);}
    if(req.query.confidence){if(!['MEDIUM','LOW','VERY_LOW'].includes(req.query.confidence))return res.status(400).json({ok:false,error:'Invalid forecast confidence'});params.push(req.query.confidence);where.push(`v.forecast_confidence=$${params.length}`);}
    const rows=await db.manyOrNone(`SELECT * FROM v_municipal_asset_risk_forecast v ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY CASE forecast_30d_exposure WHEN 'CRITICAL_EXPOSURE' THEN 1 WHEN 'HIGH_EXPOSURE' THEN 2 WHEN 'MEDIUM_EXPOSURE' THEN 3 ELSE 4 END,composite_score_30d,pole_id LIMIT 2000`,params);
    res.json({ok:true,advisory:true,forecasting:true,data:rows});
  }catch(e){logger.error('Risk forecast assets error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});
router.get('/clusters',async(req,res)=>{
  try{
    const params=[],where=[];scope(req.user,params,where);
    if(req.query.type){if(!['ZONE','WARD','ROAD'].includes(req.query.type))return res.status(400).json({ok:false,error:'Invalid cluster type'});params.push(req.query.type);where.push(`v.cluster_type=$${params.length}`);}
    const rows=await db.manyOrNone(`SELECT * FROM v_municipal_risk_forecast_clusters v ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY CASE forecast_30d_band WHEN 'CRITICAL_EXPOSURE' THEN 1 WHEN 'HIGH_EXPOSURE' THEN 2 WHEN 'MEDIUM_EXPOSURE' THEN 3 ELSE 4 END,avg_composite_score_30d LIMIT 1000`,params);
    res.json({ok:true,advisory:true,forecasting:true,data:rows});
  }catch(e){logger.error('Risk forecast clusters error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});
router.get('/command',async(req,res)=>{
  try{
    const params=[],where=[];scope(req.user,params,where);
    if(req.query.state){if(!['PREEMPTIVE_REVIEW','FUTURE_RISK_REVIEW','RECOVERY_TRAJECTORY','ROUTINE_FORECAST_MONITORING'].includes(req.query.state))return res.status(400).json({ok:false,error:'Invalid forecast review state'});params.push(req.query.state);where.push(`v.forecast_review_state=$${params.length}`);}
    const rows=await db.manyOrNone(`SELECT * FROM v_municipal_risk_forecast_command v ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY forecast_command_risk_30d DESC,avg_composite_score_30d LIMIT 1000`,params);
    res.json({ok:true,advisory:true,municipal_risk_forecast_command:true,data:rows});
  }catch(e){logger.error('Risk forecast command error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});
router.get('/summary',async(req,res)=>{
  try{
    const params=[],where=[];scope(req.user,params,where);
    const rows=await db.manyOrNone(`SELECT cluster_type,forecast_30d_band,forecast_direction,COUNT(*)::int AS clusters,SUM(assets)::int AS assets,SUM(critical_exposure_30d)::int AS critical_exposure_30d,SUM(high_exposure_30d)::int AS high_exposure_30d,ROUND(AVG(avg_composite_score_7d),2) AS avg_composite_score_7d,ROUND(AVG(avg_composite_score_30d),2) AS avg_composite_score_30d FROM v_municipal_risk_forecast_clusters v ${where.length?'WHERE '+where.join(' AND '):''} GROUP BY cluster_type,forecast_30d_band,forecast_direction ORDER BY clusters DESC`,params);
    res.json({ok:true,advisory:true,forecasting:true,data:rows});
  }catch(e){logger.error('Risk forecast summary error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});
module.exports=router;
