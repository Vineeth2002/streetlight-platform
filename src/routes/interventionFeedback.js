'use strict';
const express=require('express');
const db=require('../../config/database');
const logger=require('../utils/logger');
const {requireAuth,requireRole}=require('../middleware/auth');
const router=express.Router();
const READ=['SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','CONTRACTOR','FIELD_ENGINEER','READ_ONLY'];
router.use(requireAuth,requireRole(...READ));

function scope(user,params,conditions,alias='v'){
  if(user.role==='GVMC_EE'){params.push(user.zone_id);conditions.push(`${alias}.zone_id=$${params.length}`);}
  if(user.role==='CONTRACTOR'){params.push(user.contractor_id);conditions.push(`${alias}.contractor_id=$${params.length}`);}
  if(user.role==='FIELD_ENGINEER'){
    params.push(user.user_id);
    conditions.push(`EXISTS (SELECT 1 FROM municipal_interventions mi JOIN work_orders wo ON wo.work_order_id=mi.work_order_id WHERE mi.intervention_type=v.intervention_type AND mi.pole_id IN (SELECT pole_id FROM work_orders WHERE assigned_to=$${params.length}))`);
  }
}

router.get('/patterns',async(req,res)=>{
  try{
    const params=[],conditions=[];scope(req.user,params,conditions);
    if(req.query.intervention_type){params.push(String(req.query.intervention_type));conditions.push(`v.intervention_type=$${params.length}`);}
    if(req.query.root_cause_category){params.push(String(req.query.root_cause_category));conditions.push(`v.root_cause_category=$${params.length}`);}
    const where=conditions.length?'WHERE '+conditions.join(' AND '):'';
    const rows=await db.manyOrNone(`SELECT * FROM v_intervention_feedback_patterns v ${where} ORDER BY measured_interventions DESC,effectiveness_rate DESC NULLS LAST LIMIT 1000`,params);
    res.json({ok:true,advisory:true,learning:true,data:rows});
  }catch(e){logger.error('Intervention feedback patterns error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

router.get('/recommendations',async(req,res)=>{
  try{
    const params=[],conditions=[];scope(req.user,params,conditions,'v');
    const where=conditions.length?'WHERE '+conditions.join(' AND '):'';
    const rows=await db.manyOrNone(`
      WITH candidates AS (
        SELECT v.*,CASE
          WHEN v.measured_interventions>=3 AND v.effectiveness_rate>=80 THEN 'PREFERRED'
          WHEN v.measured_interventions>=3 AND v.effectiveness_rate<50 THEN 'REVIEW'
          WHEN v.measured_interventions>=3 THEN 'CONDITIONAL'
          ELSE 'INSUFFICIENT_EVIDENCE' END AS learning_signal
        FROM v_intervention_feedback_patterns v ${where}
      )
      SELECT *,CASE learning_signal
        WHEN 'PREFERRED' THEN 'Historical outcomes support this intervention strategy for this pattern; retain as an advisory preference.'
        WHEN 'REVIEW' THEN 'Historical outcomes are weak; review the intervention strategy and underlying cause before repeating it.'
        WHEN 'CONDITIONAL' THEN 'Historical outcomes are mixed; use human judgment and verify the underlying conditions.'
        ELSE 'Too few measured outcomes to support a learning-based preference.' END AS advisory_recommendation
      FROM candidates ORDER BY CASE learning_signal WHEN 'REVIEW' THEN 1 WHEN 'CONDITIONAL' THEN 2 WHEN 'PREFERRED' THEN 3 ELSE 4 END,measured_interventions DESC LIMIT 1000`,params);
    res.json({ok:true,advisory:true,learning:true,decision_support:true,data:rows});
  }catch(e){logger.error('Intervention feedback recommendations error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

router.get('/summary',async(req,res)=>{
  try{
    const rows=await db.manyOrNone(`SELECT intervention_type,COUNT(*)::int AS patterns,SUM(measured_interventions)::int AS measured_interventions,ROUND(AVG(effectiveness_rate),2) AS avg_effectiveness_rate FROM v_intervention_feedback_patterns GROUP BY intervention_type ORDER BY measured_interventions DESC`);
    res.json({ok:true,advisory:true,learning:true,data:rows});
  }catch(e){logger.error('Intervention feedback summary error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});
module.exports=router;
