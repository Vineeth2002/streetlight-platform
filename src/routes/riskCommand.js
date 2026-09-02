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
router.get('/queue',async(req,res)=>{
  try{
    const params=[],where=[];
    scope(req.user,params,where);
    if(req.query.band){
      if(!['LOW','MEDIUM','HIGH','CRITICAL'].includes(req.query.band))return res.status(400).json({ok:false,error:'Invalid risk band'});
      params.push(req.query.band);where.push(`v.command_risk_band=$${params.length}`);
    }
    if(req.query.type){
      if(!['CABINET','WARD','ZONE','ROAD','CONTRACTOR'].includes(req.query.type))return res.status(400).json({ok:false,error:'Invalid cluster type'});
      params.push(req.query.type);where.push(`v.cluster_type=$${params.length}`);
    }
    const rows=await db.manyOrNone(`SELECT * FROM v_municipal_risk_command v ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY command_risk_score DESC,critical_warnings DESC,network_risk_score DESC LIMIT 1000`,params);
    res.json({ok:true,advisory:true,municipal_risk_command:true,data:rows});
  }catch(e){logger.error('Risk command queue error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});
router.get('/summary',async(req,res)=>{
  try{
    const params=[],where=[];
    scope(req.user,params,where);
    const rows=await db.manyOrNone(`SELECT * FROM v_municipal_risk_command_summary v ${where.length?'WHERE EXISTS (SELECT 1 FROM v_municipal_risk_command s WHERE s.cluster_type=v.cluster_type AND s.zone_id=$1)':''} ORDER BY critical_clusters DESC,high_risk_clusters DESC,cluster_type`,params);
    res.json({ok:true,advisory:true,municipal_risk_command:true,data:rows});
  }catch(e){logger.error('Risk command summary error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});
router.get('/priority',async(req,res)=>{
  try{
    const params=[],where=[];
    scope(req.user,params,where);
    where.push(`v.command_risk_band IN ('CRITICAL','HIGH')`);
    const rows=await db.manyOrNone(`SELECT cluster_type,cluster_key,zone_id,zone_name,ward_id,ward_number,road_name,contractor_id,contractor_name,assets,critical_assets,high_risk_assets,systemic_assets,affected_assets,sla_violations_365d,failure_episodes_365d,open_interventions,network_risk_score,command_risk_score,network_risk_band,command_risk_band,dominant_network_signal,recommended_review,critical_warnings,high_warnings,severe_warnings FROM v_municipal_risk_command v WHERE ${where.join(' AND ')} ORDER BY command_risk_score DESC,critical_warnings DESC LIMIT 100`,params);
    res.json({ok:true,advisory:true,municipal_risk_command:true,data:rows});
  }catch(e){logger.error('Risk command priority error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});
module.exports=router;
