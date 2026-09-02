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
    where.push(`(${alias}.zone_id=$${params.length} OR ${alias}.zone_id IS NULL)`);
  }
}

router.get('/links',requireRole(...READ),async(req,res)=>{
  try{
    const params=[],where=[];
    scope(req.user,params,where);
    if(req.query.scenario_key){params.push(req.query.scenario_key);where.push(`v.scenario_key=$${params.length}`);}
    if(req.query.capital_program_id){const id=Number(req.query.capital_program_id);if(!Number.isInteger(id)||id<1)return res.status(400).json({ok:false,error:'Invalid capital program id'});params.push(id);where.push(`v.capital_program_id=$${params.length}`);}
    const rows=await db.manyOrNone(`SELECT * FROM v_municipal_capital_scenario_program_traceability v ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY v.selected_at DESC,v.link_id DESC LIMIT 500`,params);
    res.json({ok:true,advisory:true,scenario_program_traceability:true,data:rows});
  }catch(e){logger.error('Scenario-program traceability list error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

router.get('/summary',requireRole(...READ),async(req,res)=>{
  try{
    const params=[],where=[];
    scope(req.user,params,where);
    if(req.query.scenario_key){params.push(req.query.scenario_key);where.push(`v.scenario_key=$${params.length}`);}
    const rows=await db.manyOrNone(`SELECT * FROM v_municipal_capital_scenario_program_traceability_summary v ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY v.program_links DESC`,params);
    res.json({ok:true,advisory:true,data:rows});
  }catch(e){logger.error('Scenario-program traceability summary error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

router.post('/links',requireRole(...WRITE),async(req,res)=>{
  try{
    const scenarioKey=String(req.body.scenario_key||'').trim();
    const programId=Number(req.body.capital_program_id);
    const decisionId=req.body.decision_id===null||req.body.decision_id===undefined?null:Number(req.body.decision_id);
    const zoneId=req.body.zone_id===null||req.body.zone_id===undefined?null:Number(req.body.zone_id);
    const rationale=String(req.body.selection_rationale||'').trim();
    if(!scenarioKey||!Number.isInteger(programId)||programId<1||!rationale)return res.status(400).json({ok:false,error:'scenario_key, valid capital_program_id and selection_rationale are required'});
    if(decisionId!==null&&(!Number.isInteger(decisionId)||decisionId<1))return res.status(400).json({ok:false,error:'Invalid decision_id'});
    if(zoneId!==null&&(!Number.isInteger(zoneId)||zoneId<1))return res.status(400).json({ok:false,error:'Invalid zone_id'});
    if(req.user.role==='GVMC_EE'&&zoneId!==null&&zoneId!==Number(req.user.zone_id))return res.status(403).json({ok:false,error:'Scenario-program link outside your zone'});
    const program=await db.oneOrNone('SELECT * FROM municipal_capital_programs WHERE capital_program_id=$1',[programId]);
    if(!program)return res.status(404).json({ok:false,error:'Capital program not found'});
    if(req.user.role==='GVMC_EE'&&program.zone_id!==null&&Number(program.zone_id)!==Number(req.user.zone_id))return res.status(403).json({ok:false,error:'Capital program outside your zone'});
    if(zoneId!==null&&program.zone_id!==null&&Number(program.zone_id)!==zoneId)return res.status(400).json({ok:false,error:'Link zone does not match capital program zone'});
    let decision=null;
    if(decisionId!==null){decision=await db.oneOrNone('SELECT * FROM municipal_capital_portfolio_decisions WHERE decision_id=$1',[decisionId]);if(!decision)return res.status(404).json({ok:false,error:'Capital portfolio decision not found'});if(decision.selected_scenario_key!==scenarioKey)return res.status(400).json({ok:false,error:'Decision scenario does not match scenario_key'});if(decision.zone_id!==null&&zoneId!==null&&Number(decision.zone_id)!==zoneId)return res.status(400).json({ok:false,error:'Decision zone does not match link zone'});}
    const guidance=await db.oneOrNone(`SELECT * FROM v_municipal_capital_decision_revalidated_scenario_guidance WHERE scenario_key=$1 AND zone_id IS NOT DISTINCT FROM $2::int LIMIT 1`,[scenarioKey,zoneId]);
    const link=await db.one(`INSERT INTO municipal_capital_scenario_program_links(scenario_key,zone_id,capital_program_id,decision_id,guidance_state,revalidation_state,selection_rationale,evidence_snapshot,selected_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[scenarioKey,zoneId,programId,decisionId,guidance?.guidance_state??null,guidance?.revalidation_states??null,rationale,req.body.evidence_snapshot||{},req.user.user_id]);
    await auditLog(req,{action:'MUNICIPAL_CAPITAL_SCENARIO_PROGRAM_LINKED',entity_type:'municipal_capital_program',entity_id:programId,metadata:{scenario_key:scenarioKey,zone_id:zoneId,decision_id:decisionId,link_id:link.link_id}});
    res.status(201).json({ok:true,advisory:true,human_selected:true,data:link});
  }catch(e){logger.error('Scenario-program traceability create error',{error:e.message});if(e.code==='23505')return res.status(409).json({ok:false,error:'This scenario-program linkage already exists'});res.status(500).json({ok:false,error:'Internal server error'});}
});

module.exports=router;
