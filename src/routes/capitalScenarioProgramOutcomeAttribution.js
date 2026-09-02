'use strict';
const express=require('express');
const db=require('../../config/database');
const logger=require('../utils/logger');
const {requireAuth,requireRole,auditLog}=require('../middleware/auth');
const router=express.Router();
const READ=['SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','READ_ONLY'];
const WRITE=['SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE'];
router.use(requireAuth);

function scope(user,params,where,alias='v'){
  if(user.role==='GVMC_EE'){
    params.push(user.zone_id);
    where.push(`${alias}.zone_id=$${params.length}`);
  }
}

router.get('/attributions',requireRole(...READ),async(req,res)=>{
  try{
    const params=[],where=[];
    scope(req.user,params,where);
    if(req.query.scenario_key){params.push(req.query.scenario_key);where.push(`v.scenario_key=$${params.length}`);}
    if(req.query.capital_program_id){params.push(req.query.capital_program_id);where.push(`v.capital_program_id=$${params.length}`);}
    const rows=await db.manyOrNone(`SELECT * FROM v_municipal_capital_scenario_program_outcome_attribution v ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY v.measured_at DESC NULLS LAST,v.attribution_id DESC LIMIT 1000`,params);
    res.json({ok:true,advisory:true,scenario_program_outcome_attribution:true,data:rows});
  }catch(e){logger.error('Scenario-program outcome attribution list error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

router.get('/summary',requireRole(...READ),async(req,res)=>{
  try{
    const params=[],where=[];
    scope(req.user,params,where,'v');
    if(req.query.scenario_key){params.push(req.query.scenario_key);where.push(`v.scenario_key=$${params.length}`);}
    const rows=await db.manyOrNone(`SELECT * FROM v_municipal_capital_scenario_program_outcome_attribution_summary v ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY attribution_records DESC,scenario_key`,params);
    res.json({ok:true,advisory:true,data:rows});
  }catch(e){logger.error('Scenario-program outcome attribution summary error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

router.post('/attributions',requireRole(...WRITE),async(req,res)=>{
  try{
    const body=req.body||{};
    const linkId=Number(body.link_id),assessmentId=Number(body.outcome_assessment_id);
    if(!Number.isInteger(linkId)||linkId<=0)return res.status(400).json({ok:false,error:'Positive link_id is required'});
    if(!Number.isInteger(assessmentId)||assessmentId<=0)return res.status(400).json({ok:false,error:'Positive outcome_assessment_id is required'});
    const state=String(body.attribution_state||'').trim();
    const allowed=['PENDING','EVIDENCE_AVAILABLE','ATTRIBUTED','INSUFFICIENT_EVIDENCE','NOT_ATTRIBUTABLE'];
    if(!allowed.includes(state))return res.status(400).json({ok:false,error:`attribution_state must be one of: ${allowed.join(', ')}`});
    if(state==='ATTRIBUTED'&&!String(body.attribution_rationale||'').trim())return res.status(400).json({ok:false,error:'attribution_rationale is required for ATTRIBUTED state'});

    const link=await db.oneOrNone('SELECT * FROM municipal_capital_scenario_program_links WHERE link_id=$1',[linkId]);
    if(!link)return res.status(404).json({ok:false,error:'Scenario-program link not found'});
    if(req.user.role==='GVMC_EE'&&link.zone_id!==req.user.zone_id)return res.status(403).json({ok:false,error:'Scenario-program link outside your zone'});

    const outcome=await db.oneOrNone('SELECT * FROM v_municipal_capital_program_outcomes WHERE assessment_id=$1',[assessmentId]);
    if(!outcome)return res.status(404).json({ok:false,error:'Outcome assessment not found'});
    if(Number(outcome.capital_program_id)!==Number(link.capital_program_id))return res.status(409).json({ok:false,error:'Outcome assessment does not belong to the linked capital program'});
    const assessment=await db.one('SELECT * FROM municipal_capital_program_outcome_assessments WHERE assessment_id=$1',[assessmentId]);

    const existing=await db.oneOrNone('SELECT attribution_id FROM municipal_capital_scenario_program_outcome_attributions WHERE link_id=$1 AND outcome_assessment_id=$2',[linkId,assessmentId]);
    if(existing)return res.status(409).json({ok:false,error:'Outcome attribution already exists for this scenario-program link and assessment',attribution_id:existing.attribution_id});

    const baselineSnapshot=(body.baseline_snapshot&&typeof body.baseline_snapshot==='object'&&!Array.isArray(body.baseline_snapshot))?body.baseline_snapshot:{
      expected_benefit_score:assessment.expected_benefit_score,
      health_score:assessment.baseline_health_score,
      reliability_score:assessment.baseline_reliability_score,
      open_work_orders:assessment.baseline_open_work_orders,
      sla_exposure:assessment.baseline_sla_exposure,
      penalty_inr:assessment.baseline_penalty_inr
    };
    const outcomeSnapshot=(body.outcome_snapshot&&typeof body.outcome_snapshot==='object'&&!Array.isArray(body.outcome_snapshot))?body.outcome_snapshot:{
      observed_benefit_score:outcome.observed_benefit_score,
      health_delta:outcome.health_delta,
      reliability_delta:outcome.reliability_delta,
      work_order_delta:outcome.work_order_delta,
      sla_exposure_delta:outcome.sla_exposure_delta,
      penalty_delta_inr:outcome.penalty_delta_inr,
      outcome_band:outcome.outcome_band,
      measured_at:outcome.measured_at
    };
    const row=await db.one(`INSERT INTO municipal_capital_scenario_program_outcome_attributions(link_id,capital_program_id,outcome_assessment_id,attribution_state,baseline_snapshot,outcome_snapshot,attribution_rationale,evidence_captured_at,assessed_by,assessed_at) VALUES($1,$2,$3,$4,$5,$6,$7,NOW(),$8,NOW()) RETURNING *`,[linkId,link.capital_program_id,assessmentId,state,baselineSnapshot,outcomeSnapshot,String(body.attribution_rationale||'').trim()||null,req.user.user_id]);
    await auditLog(req,{action:'MUNICIPAL_CAPITAL_SCENARIO_PROGRAM_OUTCOME_ATTRIBUTED',entity_type:'capital_scenario_program_link',entity_id:String(linkId),metadata:{attribution_id:row.attribution_id,outcome_assessment_id:assessmentId,capital_program_id:link.capital_program_id,attribution_state:state,causal_claim:'NOT_ESTABLISHED'}});
    res.status(201).json({ok:true,advisory:true,human_attribution:true,causal_claim_established:false,data:row});
  }catch(e){logger.error('Scenario-program outcome attribution error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

module.exports=router;
