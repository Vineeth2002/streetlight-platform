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
router.get('/clusters',async(req,res)=>{
  try{
    const params=[],where=[];
    scope(req.user,params,where);
    if(req.query.type){
      const types=['CABINET','WARD','ZONE','ROAD','CONTRACTOR'];
      if(!types.includes(req.query.type))return res.status(400).json({ok:false,error:'Invalid cluster type'});
      params.push(req.query.type);where.push(`v.cluster_type=$${params.length}`);
    }
    if(req.query.band){
      const bands=['LOW','MEDIUM','HIGH','CRITICAL'];
      if(!bands.includes(req.query.band))return res.status(400).json({ok:false,error:'Invalid risk band'});
      params.push(req.query.band);where.push(`v.network_risk_band=$${params.length}`);
    }
    if(req.query.min_risk!==undefined){
      const n=Number(req.query.min_risk);
      if(!Number.isFinite(n)||n<0||n>100)return res.status(400).json({ok:false,error:'Invalid min_risk'});
      params.push(n);where.push(`v.network_risk_score>=$${params.length}`);
    }
    const rows=await db.manyOrNone(`SELECT * FROM v_municipal_network_risk_clusters v ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY network_risk_score DESC,critical_assets DESC,assets DESC,cluster_type,cluster_key LIMIT 5000`,params);
    res.json({ok:true,advisory:true,municipal_network_risk:true,data:rows});
  }catch(e){logger.error('Network risk clusters error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});
router.get('/summary',async(req,res)=>{
  try{
    const params=[],where=[];
    scope(req.user,params,where);
    const rows=await db.manyOrNone(`SELECT * FROM v_municipal_network_risk_summary v ${where.length?'WHERE EXISTS (SELECT 1 FROM v_municipal_network_risk_clusters s WHERE s.cluster_type=v.cluster_type AND s.zone_id=$1)':''} ORDER BY critical_clusters DESC,high_risk_clusters DESC,cluster_type`,params);
    res.json({ok:true,advisory:true,municipal_network_risk:true,data:rows});
  }catch(e){logger.error('Network risk summary error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});
router.get('/hotspots',async(req,res)=>{
  try{
    const params=[],where=[];
    scope(req.user,params,where);
    where.push(`v.network_risk_band IN ('CRITICAL','HIGH')`);
    const rows=await db.manyOrNone(`SELECT * FROM v_municipal_network_risk_clusters v WHERE ${where.join(' AND ')} ORDER BY network_risk_score DESC,critical_assets DESC LIMIT 100`,params);
    res.json({ok:true,advisory:true,municipal_network_risk:true,data:rows});
  }catch(e){logger.error('Network risk hotspots error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});
module.exports=router;
