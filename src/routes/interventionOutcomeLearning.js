'use strict';
const express=require('express');
const Joi=require('joi');
const db=require('../../config/database');
const logger=require('../utils/logger');
const {requireAuth,requireRole,auditLog}=require('../middleware/auth');
const router=express.Router();
const READ=['SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','CONTRACTOR','FIELD_ENGINEER','READ_ONLY'];
const WRITE=['SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE'];
router.use(requireAuth,requireRole(...READ));

async function interventionScope(user,id) {
  const row=await db.oneOrNone(`SELECT mi.*,p.pole_number FROM municipal_interventions mi LEFT JOIN poles p ON p.pole_id=mi.pole_id WHERE mi.intervention_id=$1`,[id]);
  if(!row)return {row:null,allowed:false};
  if(user.role==='GVMC_EE'&&row.zone_id!==user.zone_id)return {row,allowed:false};
  if(user.role==='CONTRACTOR'){const own=await db.oneOrNone(`SELECT 1 FROM work_orders WHERE pole_id=$1 AND contractor_id=$2 LIMIT 1`,[row.pole_id,user.contractor_id]);if(!own)return {row,allowed:false};}
  if(user.role==='FIELD_ENGINEER'){const own=await db.oneOrNone(`SELECT 1 FROM work_orders WHERE pole_id=$1 AND assigned_to=$2 LIMIT 1`,[row.pole_id,user.user_id]);if(!own)return {row,allowed:false};}
  return {row,allowed:true};
}

router.get('/summary',async(req,res)=>{try{
  const params=[];const conditions=[];
  if(req.user.role==='GVMC_EE'){params.push(req.user.zone_id);conditions.push(`mi.zone_id=$${params.length}`);}
  if(req.user.role==='CONTRACTOR'){params.push(req.user.contractor_id);conditions.push(`EXISTS(SELECT 1 FROM work_orders wo WHERE wo.pole_id=mi.pole_id AND wo.contractor_id=$${params.length})`);}
  if(req.user.role==='FIELD_ENGINEER'){params.push(req.user.user_id);conditions.push(`EXISTS(SELECT 1 FROM work_orders wo WHERE wo.pole_id=mi.pole_id AND wo.assigned_to=$${params.length})`);}
  const where=conditions.length?'WHERE '+conditions.join(' AND '):'';
  const rows=await db.manyOrNone(`SELECT mi.intervention_type,
    COUNT(*) FILTER (WHERE lo.outcome='EFFECTIVE')::int AS effective_count,
    COUNT(*) FILTER (WHERE lo.outcome='PARTIAL')::int AS partial_count,
    COUNT(*) FILTER (WHERE lo.outcome='INEFFECTIVE')::int AS ineffective_count,
    COUNT(*) FILTER (WHERE lo.outcome='UNMEASURED')::int AS unmeasured_count,
    COUNT(lo.measurement_id)::int AS measured_interventions,
    CASE WHEN COUNT(lo.measurement_id) FILTER (WHERE lo.outcome IN ('EFFECTIVE','PARTIAL','INEFFECTIVE'))=0 THEN NULL
         ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE lo.outcome='EFFECTIVE') /
              COUNT(*) FILTER (WHERE lo.outcome IN ('EFFECTIVE','PARTIAL','INEFFECTIVE')),2) END AS effectiveness_rate
    FROM municipal_interventions mi
    LEFT JOIN v_intervention_latest_outcomes lo ON lo.intervention_id=mi.intervention_id
    ${where} GROUP BY mi.intervention_type ORDER BY mi.intervention_type`,params);
  res.json({ok:true,advisory:true,data:rows});
}catch(e){logger.error('Intervention learning summary error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}});

router.get('/',async(req,res)=>{try{const params=[],where=[];if(req.user.role==='GVMC_EE'){params.push(req.user.zone_id);where.push(`mi.zone_id=$${params.length}`);}if(req.user.role==='CONTRACTOR'){params.push(req.user.contractor_id);where.push(`EXISTS(SELECT 1 FROM work_orders wo WHERE wo.pole_id=mi.pole_id AND wo.contractor_id=$${params.length})`);}if(req.user.role==='FIELD_ENGINEER'){params.push(req.user.user_id);where.push(`EXISTS(SELECT 1 FROM work_orders wo WHERE wo.pole_id=mi.pole_id AND wo.assigned_to=$${params.length})`);}const rows=await db.manyOrNone(`SELECT lo.*,p.pole_number FROM v_intervention_latest_outcomes lo JOIN municipal_interventions mi ON mi.intervention_id=lo.intervention_id LEFT JOIN poles p ON p.pole_id=lo.pole_id ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY lo.measured_at DESC LIMIT 1000`,params);res.json({ok:true,advisory:true,data:rows});}catch(e){logger.error('Intervention outcomes list error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}});

router.get('/:id',async(req,res)=>{const id=Number.parseInt(req.params.id,10);if(!Number.isInteger(id))return res.status(400).json({ok:false,error:'Invalid intervention id'});try{const s=await interventionScope(req.user,id);if(!s.row||!s.allowed)return res.status(404).json({ok:false,error:'Intervention not found'});const rows=await db.manyOrNone(`SELECT o.*,u.full_name AS measured_by_name FROM intervention_outcome_measurements o LEFT JOIN users u ON u.user_id=o.measured_by WHERE o.intervention_id=$1 ORDER BY o.measured_at DESC,o.measurement_id DESC`,[id]);res.json({ok:true,advisory:true,intervention:s.row,outcomes:rows});}catch(e){logger.error('Intervention outcome detail error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}});

const manualSchema=Joi.object({outcome:Joi.string().valid('EFFECTIVE','PARTIAL','INEFFECTIVE','UNMEASURED').required(),observation_window_days:Joi.number().integer().min(1).max(3650).default(30),recurrence_count:Joi.number().integer().min(0).default(0),evidence:Joi.object().default({}),notes:Joi.string().max(4000).allow('',null)});
router.post('/:id',requireRole(...WRITE),async(req,res)=>{const id=Number.parseInt(req.params.id,10);if(!Number.isInteger(id))return res.status(400).json({ok:false,error:'Invalid intervention id'});const {error,value}=manualSchema.validate(req.body,{abortEarly:false});if(error)return res.status(400).json({ok:false,error:error.details.map(x=>x.message).join('; ')});try{const s=await interventionScope(req.user,id);if(!s.row||!s.allowed)return res.status(404).json({ok:false,error:'Intervention not found'});const row=await db.one(`INSERT INTO intervention_outcome_measurements(intervention_id,pole_id,outcome,measurement_source,observation_window_days,recurrence_count,evidence,notes,measured_by) VALUES($1,$2,$3,'HUMAN',$4,$5,$6,$7,$8) RETURNING *`,[id,s.row.pole_id,value.outcome,value.observation_window_days,value.recurrence_count,value.evidence||{},value.notes||null,req.user.user_id]);await auditLog(req.user.user_id,'INTERVENTION_OUTCOME_RECORDED','municipal_interventions',id,true,{measurement_id:row.measurement_id,outcome:row.outcome},req);res.status(201).json({ok:true,advisory:true,outcome:row});}catch(e){logger.error('Manual intervention outcome error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}});

router.post('/:id/evaluate',requireRole(...WRITE),async(req,res)=>{const id=Number.parseInt(req.params.id,10);if(!Number.isInteger(id))return res.status(400).json({ok:false,error:'Invalid intervention id'});const windowDays=Number.isInteger(req.body?.observation_window_days)?req.body.observation_window_days:30;if(windowDays<1||windowDays>3650)return res.status(400).json({ok:false,error:'Invalid observation_window_days'});try{const s=await interventionScope(req.user,id);if(!s.row||!s.allowed)return res.status(404).json({ok:false,error:'Intervention not found'});const outcome=await db.tx(async t=>{let wo=null;if(s.row.work_order_id){wo=await t.oneOrNone(`SELECT work_order_id,pole_id,ticket_status,resolved_timestamp FROM work_orders WHERE work_order_id=$1`,[s.row.work_order_id]);if(!wo)throw Object.assign(new Error('WORK_ORDER_NOT_FOUND'),{code:'WORK_ORDER_NOT_FOUND'});}let verification=null;if(wo){verification=await t.oneOrNone(`SELECT result,verified_at FROM work_order_verifications WHERE work_order_id=$1 ORDER BY verified_at DESC LIMIT 1`,[wo.work_order_id]);}const completedAt=wo?.resolved_timestamp||s.row.decided_at;const elapsed=completedAt?Math.floor((Date.now()-new Date(completedAt).getTime())/86400000):0;let recurrence=0;if(s.row.pole_id&&completedAt){const r=await t.one(`SELECT COUNT(*)::int AS count FROM work_orders WHERE pole_id=$1 AND reported_timestamp>$2 AND reported_timestamp<=($2 + ($3 || ' days')::interval) AND work_order_id<>COALESCE($4,0)`,[s.row.pole_id,completedAt,windowDays,s.row.work_order_id||null]);recurrence=r.count;}let result='UNMEASURED';if(!wo&&!s.row.work_order_id)result='UNMEASURED';else if(wo.ticket_status==='CANCELLED')result='INEFFECTIVE';else if(verification?.result==='FAIL')result='INEFFECTIVE';else if(verification?.result==='PARTIAL')result='PARTIAL';else if(wo.ticket_status==='RESOLVED'&&verification?.result==='PASS'&&elapsed>=windowDays)result=recurrence===0?'EFFECTIVE':'INEFFECTIVE';const evidence={evaluation:'AUTOMATED',completed_at:completedAt||null,elapsed_days:elapsed,window_days:windowDays,recurrence_count:recurrence,verification_result:verification?.result||null};return t.one(`INSERT INTO intervention_outcome_measurements(intervention_id,pole_id,outcome,measurement_source,observation_window_days,recurrence_count,work_order_status,verification_result,asset_status,evidence) VALUES($1,$2,$3,'AUTOMATED',$4,$5,$6,$7,$8,$9) RETURNING *`,[id,s.row.pole_id,result,windowDays,recurrence,wo?.ticket_status||null,verification?.result||null,(await t.oneOrNone('SELECT current_status FROM poles WHERE pole_id=$1',[s.row.pole_id]))?.current_status||null,evidence]);});await auditLog(req.user.user_id,'INTERVENTION_OUTCOME_EVALUATED','municipal_interventions',id,true,{measurement_id:outcome.measurement_id,outcome:outcome.outcome},req);res.status(201).json({ok:true,advisory:true,outcome});}catch(e){if(e.code==='WORK_ORDER_NOT_FOUND')return res.status(409).json({ok:false,error:'Linked work order no longer exists'});logger.error('Intervention outcome evaluation error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}});
module.exports=router;
