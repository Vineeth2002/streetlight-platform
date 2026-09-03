'use strict';

const express = require('express');
const Joi = require('joi');
const db = require('../../config/database');
const logger = require('../utils/logger');
const { requireAuth, requireRole, auditLog } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
const READ_ROLES = ['SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','CONTRACTOR','FIELD_ENGINEER','READ_ONLY'];
const PLAN_ROLES = ['SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE'];
router.use(requireRole(...READ_ROLES));

function assertScopedIdentity(user, res) {
  if (user.role === 'GVMC_EE' && !user.zone_id) {
    res.status(403).json({ok:false,error:'Access denied: user has no assigned zone'});
    return false;
  }
  if (user.role === 'CONTRACTOR' && !user.contractor_id) {
    res.status(403).json({ok:false,error:'Access denied: user has no assigned contractor'});
    return false;
  }
  if (user.role === 'FIELD_ENGINEER' && !user.user_id) {
    res.status(403).json({ok:false,error:'Access denied: user identity is unavailable'});
    return false;
  }
  return true;
}

function scopeCandidate(user, params, conditions) {
  if (user.role === 'GVMC_EE') { params.push(user.zone_id); conditions.push(`zone_id=$${params.length}`); }
  if (user.role === 'CONTRACTOR') {
    params.push(user.contractor_id);
    conditions.push(`EXISTS (SELECT 1 FROM contract_asset_assignments ca JOIN municipal_contracts mc ON mc.contract_id=ca.contract_id WHERE ca.pole_id=v.pole_id AND mc.contractor_id=$${params.length})`);
  }
  if (user.role === 'FIELD_ENGINEER') {
    params.push(user.user_id);
    conditions.push(`EXISTS (SELECT 1 FROM work_orders wo WHERE wo.pole_id=v.pole_id AND wo.assigned_to=$${params.length})`);
  }
}

router.get('/candidates', async (req,res) => {
  try {
    if (!assertScopedIdentity(req.user,res)) return;
    const params=[],conditions=[]; scopeCandidate(req.user,params,conditions);
    const priority=req.query.priority;
    if(priority) { if(!['LOW','MEDIUM','HIGH','CRITICAL'].includes(priority)) return res.status(400).json({ok:false,error:'Invalid priority'}); params.push(priority); conditions.push(`replacement_priority=$${params.length}`); }
    const where=conditions.length?`WHERE ${conditions.join(' AND ')}`:'';
    const data=await db.manyOrNone(`SELECT * FROM v_asset_replacement_candidates v ${where} ORDER BY CASE replacement_priority WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END, risk_score DESC NULLS LAST, repair_count_365d DESC NULLS LAST LIMIT 1000`,params);
    const summary=data.reduce((a,r)=>{a[r.replacement_priority]=(a[r.replacement_priority]||0)+1;return a;},{});
    res.json({ok:true,advisory:true,summary,data});
  } catch(err) { logger.error('Replacement candidates error',{error:err.message}); res.status(500).json({ok:false,error:'Internal server error'}); }
});

router.get('/plans', async (req,res) => {
  try {
    if (!assertScopedIdentity(req.user,res)) return;
    const params=[],conditions=[];
    if(req.user.role==='GVMC_EE'){params.push(req.user.zone_id);conditions.push(`v.zone_id=$${params.length}`);}
    if(req.user.role==='CONTRACTOR'){params.push(req.user.contractor_id);conditions.push(`EXISTS (SELECT 1 FROM contract_asset_assignments ca JOIN municipal_contracts mc ON mc.contract_id=ca.contract_id WHERE ca.pole_id=v.pole_id AND mc.contractor_id=$${params.length})`);}
    const where=conditions.length?`WHERE ${conditions.join(' AND ')}`:'';
    const rows=await db.manyOrNone(`SELECT p.*,v.pole_number,v.current_status,v.zone_id,v.zone_name,v.risk_score,v.risk_band FROM asset_replacement_plans p JOIN v_asset_replacement_candidates v ON v.pole_id=p.pole_id ${where} ORDER BY CASE p.priority WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,p.proposed_replacement_date NULLS LAST,p.created_at DESC LIMIT 1000`,params);
    res.json({ok:true,advisory:true,data:rows});
  } catch(err) { logger.error('Replacement plans error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'}); }
});

const planSchema=Joi.object({pole_id:Joi.number().integer().positive().required(),budget_id:Joi.number().integer().positive().allow(null),priority:Joi.string().valid('LOW','MEDIUM','HIGH','CRITICAL').required(),proposed_replacement_date:Joi.date().iso().allow(null),estimated_cost_inr:Joi.number().min(0).allow(null),reason:Joi.string().min(5).max(2000).required(),notes:Joi.string().max(4000).allow('',null),metadata:Joi.object().default({})});

router.post('/plans',requireRole(...PLAN_ROLES),async(req,res)=>{
  if (!assertScopedIdentity(req.user,res)) return;
  const {error,value}=planSchema.validate(req.body,{abortEarly:false});
  if(error)return res.status(400).json({ok:false,error:error.details.map(x=>x.message).join('; ')});
  try {
    const asset=await db.oneOrNone(`SELECT pole_id,zone_id FROM v_asset_replacement_candidates WHERE pole_id=$1`,[value.pole_id]);
    if(!asset)return res.status(404).json({ok:false,error:'Asset not found or decommissioned'});
    if(req.user.role==='GVMC_EE'&&asset.zone_id!==req.user.zone_id)return res.status(403).json({ok:false,error:'Access denied'});
    if(value.budget_id){const budget=await db.oneOrNone('SELECT budget_id,zone_id FROM municipal_budgets WHERE budget_id=$1',[value.budget_id]);if(!budget)return res.status(404).json({ok:false,error:'Budget not found'});if(req.user.role==='GVMC_EE'&&budget.zone_id!==null&&budget.zone_id!==req.user.zone_id)return res.status(403).json({ok:false,error:'Budget outside EE zone'});}
    const row=await db.one(`INSERT INTO asset_replacement_plans(pole_id,budget_id,priority,proposed_replacement_date,estimated_cost_inr,reason,status,created_by,notes,metadata) VALUES($1,$2,$3,$4,$5,$6,'PROPOSED',$7,$8,$9) RETURNING *`,[value.pole_id,value.budget_id||null,value.priority,value.proposed_replacement_date||null,value.estimated_cost_inr??null,value.reason,req.user.user_id,value.notes||null,value.metadata||{}]);
    await auditLog(req,'ASSET_REPLACEMENT_PLAN_CREATED',{plan_id:row.plan_id,pole_id:row.pole_id,priority:row.priority});
    res.status(201).json({ok:true,advisory:true,plan:row});
  } catch(err){logger.error('Create replacement plan error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

router.patch('/plans/:id/status',requireRole(...PLAN_ROLES),async(req,res)=>{
  if (!assertScopedIdentity(req.user,res)) return;
  const id=Number.parseInt(req.params.id,10); if(!Number.isInteger(id))return res.status(400).json({ok:false,error:'Invalid plan id'});
  const schema=Joi.object({status:Joi.string().valid('PROPOSED','APPROVED','SCHEDULED','COMPLETED','DEFERRED','CANCELLED').required(),notes:Joi.string().max(4000).allow('',null)});
  const {error,value}=schema.validate(req.body);if(error)return res.status(400).json({ok:false,error:error.message});
  try {
    const plan=await db.oneOrNone(`SELECT p.*,v.zone_id FROM asset_replacement_plans p JOIN v_asset_replacement_candidates v ON v.pole_id=p.pole_id WHERE p.plan_id=$1`,[id]);
    if(!plan)return res.status(404).json({ok:false,error:'Replacement plan not found'});
    if(req.user.role==='GVMC_EE'&&plan.zone_id!==req.user.zone_id)return res.status(403).json({ok:false,error:'Access denied'});
    const approvedAt=value.status==='APPROVED'&&plan.status!=='APPROVED'?new Date():plan.approved_at;
    const updated=await db.one(`UPDATE asset_replacement_plans SET status=$1,notes=COALESCE($2,notes),approved_by=CASE WHEN $1='APPROVED' THEN $3 ELSE approved_by END,approved_at=CASE WHEN $1='APPROVED' THEN $4 ELSE approved_at END WHERE plan_id=$5 RETURNING *`,[value.status,value.notes||null,req.user.user_id,approvedAt,id]);
    await auditLog(req,'ASSET_REPLACEMENT_PLAN_STATUS_CHANGED',{plan_id:id,from_status:plan.status,to_status:value.status});
    res.json({ok:true,advisory:true,plan:updated});
  } catch(err){logger.error('Replacement plan status error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

module.exports=router;
