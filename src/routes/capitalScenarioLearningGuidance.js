'use strict';
const express=require('express');
const db=require('../../config/database');
const logger=require('../utils/logger');
const {requireAuth,requireRole}=require('../middleware/auth');
const router=express.Router();
const READ=['SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','READ_ONLY'];
router.use(requireAuth);
function scope(user,params,where,alias='v'){
  if(user.role==='GVMC_EE'){
    params.push(user.zone_id);
    where.push(`${alias}.zone_id=$${params.length}`);
  }
}
router.get('/guidance',requireRole(...READ),async(req,res)=>{
  try{
    const params=[],where=[]; scope(req.user,params,where);
    if(req.query.scenario_key){params.push(req.query.scenario_key);where.push(`v.scenario_key=$${params.length}`);}
    const rows=await db.manyOrNone(`SELECT * FROM v_municipal_capital_scenario_learning_guidance v ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY CASE guidance_state WHEN 'HISTORICAL_NEGATIVE_PATTERN' THEN 1 WHEN 'HISTORICAL_MIXED_PATTERN' THEN 2 WHEN 'INSUFFICIENT_HISTORICAL_EVIDENCE' THEN 3 WHEN 'NO_HISTORICAL_OUTCOME_EVIDENCE' THEN 4 ELSE 5 END,v.scenario_key LIMIT 1000`,params);
    res.json({ok:true,advisory:true,human_review_required:true,automatic_scenario_selection:false,data:rows});
  }catch(e){logger.error('Scenario learning guidance error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});
router.get('/summary',requireRole(...READ),async(req,res)=>{
  try{
    const params=[],where=[]; scope(req.user,params,where);
    const rows=await db.manyOrNone(`SELECT * FROM v_municipal_capital_scenario_learning_guidance_summary v ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY scenarios DESC`,params);
    res.json({ok:true,advisory:true,data:rows});
  }catch(e){logger.error('Scenario learning guidance summary error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});
module.exports=router;
