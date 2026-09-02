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
router.get('/priority',async(req,res)=>{
  try{
    const params=[],where=[];scope(req.user,params,where);
    if(req.query.band){if(!['IMMEDIATE_REVIEW','HIGH_REVIEW','PLANNING_REVIEW','ROUTINE_REVIEW'].includes(req.query.band))return res.status(400).json({ok:false,error:'Invalid allocation review band'});params.push(req.query.band);where.push(`v.allocation_review_band=$${params.length}`);}
    const rows=await db.manyOrNone(`SELECT * FROM v_municipal_resource_allocation v ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY allocation_priority_score DESC,critical_exposure_30d DESC,high_exposure_30d DESC LIMIT 1000`,params);
    res.json({ok:true,advisory:true,resource_allocation_intelligence:true,data:rows});
  }catch(e){logger.error('Resource allocation priority error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});
router.get('/summary',async(req,res)=>{
  try{
    const params=[],where=[];scope(req.user,params,where);
    const rows=await db.manyOrNone(`SELECT * FROM v_municipal_resource_allocation_summary v ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY avg_priority_score DESC NULLS LAST`,params);
    res.json({ok:true,advisory:true,resource_allocation_intelligence:true,data:rows});
  }catch(e){logger.error('Resource allocation summary error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});
router.get('/constraints',async(req,res)=>{
  try{
    const params=[],where=[];scope(req.user,params,where);
    const rows=await db.manyOrNone(`SELECT zone_id,primary_resource_constraint,COUNT(*)::int AS clusters,SUM(assets)::int AS assets,ROUND(AVG(allocation_priority_score),2) AS avg_priority_score FROM v_municipal_resource_allocation v ${where.length?'WHERE '+where.join(' AND '):''} GROUP BY zone_id,primary_resource_constraint ORDER BY avg_priority_score DESC`,params);
    res.json({ok:true,advisory:true,resource_allocation_intelligence:true,data:rows});
  }catch(e){logger.error('Resource allocation constraints error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});
module.exports=router;
