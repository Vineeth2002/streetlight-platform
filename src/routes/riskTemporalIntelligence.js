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
    if(req.query.direction){if(!['RISING','IMPROVING','STABLE','NO_HISTORY'].includes(req.query.direction))return res.status(400).json({ok:false,error:'Invalid trend direction'});params.push(req.query.direction);where.push(`v.trend_direction=$${params.length}`);}
    if(req.query.state){if(!['NEW','RECENT','PERSISTENT','RECOVERING'].includes(req.query.state))return res.status(400).json({ok:false,error:'Invalid temporal state'});params.push(req.query.state);where.push(`v.trend_persistence=$${params.length}`);}
    const rows=await db.manyOrNone(`SELECT * FROM v_municipal_asset_risk_trends v ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY ABS(composite_delta) DESC,pole_id LIMIT 2000`,params);
    res.json({ok:true,advisory:true,temporal_intelligence:true,data:rows});
  }catch(e){logger.error('Risk temporal assets error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});
router.get('/clusters',async(req,res)=>{
  try{
    const params=[],where=[];scope(req.user,params,where);
    if(req.query.type){if(!['ZONE','WARD','ROAD'].includes(req.query.type))return res.status(400).json({ok:false,error:'Invalid cluster type'});params.push(req.query.type);where.push(`v.cluster_type=$${params.length}`);}
    if(req.query.direction){if(!['RISING','IMPROVING','STABLE','PERSISTENT'].includes(req.query.direction))return res.status(400).json({ok:false,error:'Invalid cluster direction'});params.push(req.query.direction);where.push(`v.cluster_trend_direction=$${params.length}`);}
    const rows=await db.manyOrNone(`SELECT * FROM v_municipal_risk_temporal_clusters v ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY CASE cluster_trend_direction WHEN 'RISING' THEN 1 WHEN 'PERSISTENT' THEN 2 WHEN 'IMPROVING' THEN 3 ELSE 4 END,ABS(avg_composite_delta) DESC LIMIT 1000`,params);
    res.json({ok:true,advisory:true,temporal_intelligence:true,data:rows});
  }catch(e){logger.error('Risk temporal clusters error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});
router.get('/command',async(req,res)=>{
  try{
    const params=[],where=[];scope(req.user,params,where);
    if(req.query.state){params.push(req.query.state);where.push(`v.temporal_priority_state=$${params.length}`);}
    const rows=await db.manyOrNone(`SELECT * FROM v_municipal_risk_temporal_command v ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY temporal_risk_score DESC,ABS(avg_composite_delta) DESC LIMIT 1000`,params);
    res.json({ok:true,advisory:true,municipal_risk_temporal_command:true,data:rows});
  }catch(e){logger.error('Risk temporal command error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});
router.get('/summary',async(req,res)=>{
  try{
    const params=[],where=[];scope(req.user,params,where);
    const rows=await db.manyOrNone(`SELECT cluster_trend_direction,cluster_temporal_state,COUNT(*)::int AS clusters,SUM(assets)::int AS assets,SUM(rising_assets)::int AS rising_assets,SUM(improving_assets)::int AS improving_assets,SUM(persistent_assets)::int AS persistent_assets,SUM(new_signal_assets)::int AS new_signal_assets,ROUND(AVG(avg_composite_delta),2) AS avg_composite_delta FROM v_municipal_risk_temporal_clusters v ${where.length?'WHERE '+where.join(' AND '):''} GROUP BY cluster_trend_direction,cluster_temporal_state ORDER BY clusters DESC`,params);
    res.json({ok:true,advisory:true,temporal_intelligence:true,data:rows});
  }catch(e){logger.error('Risk temporal summary error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});
module.exports=router;
