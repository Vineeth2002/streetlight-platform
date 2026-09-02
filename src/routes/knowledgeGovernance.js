'use strict';

const express = require('express');
const db = require('../../config/database');
const logger = require('../utils/logger');
const { requireAuth, requireRole, auditLog } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const READ_ROLES = ['SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','CONTRACTOR','FIELD_ENGINEER','READ_ONLY'];
const WRITE_ROLES = ['SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE'];
const STATUSES = ['DRAFT','ACTIVE','ARCHIVED'];
const ACTIONS = new Set(['CREATED','UPDATED','ARCHIVED','RESTORED']);

function clean(value, max) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function validDateWindow(from, to) {
  if (!from || !to) return true;
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Number.isFinite(a) && Number.isFinite(b) && b >= a;
}

function eventAction(before, after) {
  if (before.status !== 'ARCHIVED' && after.status === 'ARCHIVED') return 'ARCHIVED';
  if (before.status === 'ARCHIVED' && after.status === 'ACTIVE') return 'RESTORED';
  return 'UPDATED';
}

async function writeEvent(knowledgeId, action, actorId, beforeState, afterState, notes, req) {
  if (!ACTIONS.has(action)) throw new Error('Invalid knowledge event action');
  await db.none(`INSERT INTO knowledge_item_events(knowledge_id,action,changed_by,before_state,after_state,notes,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)`, [knowledgeId, action, actorId, beforeState || null, afterState || null, notes || null, JSON.stringify({ ip: req.ip, user_agent: req.get('user-agent') || null })]);
}

router.get('/', requireRole(...READ_ROLES), async (req, res) => {
  try {
    const category = clean(req.query.category, 60);
    const requestedStatus = clean(req.query.status, 15);
    if (requestedStatus && !STATUSES.includes(requestedStatus)) return res.status(400).json({ok:false,error:'Invalid status'});
    const privileged = ['SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE'].includes(req.user.role);
    const params = [];
    const clauses = [];
    if (category) { params.push(category); clauses.push(`category=$${params.length}`); }
    if (requestedStatus) { params.push(requestedStatus); clauses.push(`status=$${params.length}`); }
    else if (!privileged) clauses.push("status='ACTIVE'");
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await db.manyOrNone(`SELECT knowledge_id,title,category,body,source_reference,effective_from,effective_to,version,status,metadata,created_by,created_at,updated_at FROM municipal_knowledge_items ${where} ORDER BY category,title,updated_at DESC`, params);
    res.json({ok:true,data:rows});
  } catch (err) {
    logger.error('Knowledge governance list error',{error:err.message});
    res.status(500).json({ok:false,error:'Internal server error'});
  }
});

router.get('/:id', requireRole(...READ_ROLES), async (req,res) => {
  const id = Number.parseInt(req.params.id,10);
  if (!Number.isInteger(id)) return res.status(400).json({ok:false,error:'Invalid knowledge id'});
  try {
    const row = await db.oneOrNone(`SELECT * FROM municipal_knowledge_items WHERE knowledge_id=$1`,[id]);
    if (!row) return res.status(404).json({ok:false,error:'Knowledge item not found'});
    if (row.status !== 'ACTIVE' && !['SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE'].includes(req.user.role)) return res.status(404).json({ok:false,error:'Knowledge item not found'});
    const events = await db.manyOrNone(`SELECT event_id,action,changed_by,changed_at,before_state,after_state,notes,metadata FROM knowledge_item_events WHERE knowledge_id=$1 ORDER BY changed_at DESC,event_id DESC LIMIT 100`,[id]);
    res.json({ok:true,data:row,history:events});
  } catch(err) {
    logger.error('Knowledge governance detail error',{error:err.message});
    res.status(500).json({ok:false,error:'Internal server error'});
  }
});

router.post('/', requireRole(...WRITE_ROLES), async (req,res) => {
  const b = req.body || {};
  const title=clean(b.title,255), category=clean(b.category,60), body=clean(b.body,100000), source=clean(b.source_reference,500);
  const from=clean(b.effective_from,10), to=clean(b.effective_to,10), version=clean(b.version,40);
  if (!title || !category || !body || !source) return res.status(400).json({ok:false,error:'title, category, body and source_reference are required'});
  if (!validDateWindow(from,to)) return res.status(400).json({ok:false,error:'effective_to must be on or after effective_from'});
  const status=clean(b.status,15) || 'DRAFT';
  if (!STATUSES.includes(status)) return res.status(400).json({ok:false,error:'Invalid status'});
  try {
    const row=await db.one(`INSERT INTO municipal_knowledge_items(title,category,body,source_reference,effective_from,effective_to,version,status,metadata,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[title,category,body,source,from,to,version,status,b.metadata||{},req.user.user_id]);
    await writeEvent(row.knowledge_id,'CREATED',req.user.user_id,null,row,'Initial authoritative knowledge record',req);
    await auditLog(req.user.user_id,'KNOWLEDGE_ITEM_CREATED','municipal_knowledge_item',row.knowledge_id,true,{category,status,source_reference:source},req);
    res.status(201).json({ok:true,data:row});
  } catch(err) {
    logger.error('Knowledge governance create error',{error:err.message});
    res.status(500).json({ok:false,error:'Internal server error'});
  }
});

router.patch('/:id', requireRole(...WRITE_ROLES), async (req,res) => {
  const id=Number.parseInt(req.params.id,10);
  if (!Number.isInteger(id)) return res.status(400).json({ok:false,error:'Invalid knowledge id'});
  const allowed=['title','category','body','source_reference','effective_from','effective_to','version','status','metadata','notes'];
  const input=req.body||{};
  const unknown=Object.keys(input).filter(k=>!allowed.includes(k));
  if (unknown.length) return res.status(400).json({ok:false,error:`Unsupported fields: ${unknown.join(', ')}`});
  try {
    const before=await db.oneOrNone(`SELECT * FROM municipal_knowledge_items WHERE knowledge_id=$1`,[id]);
    if(!before)return res.status(404).json({ok:false,error:'Knowledge item not found'});
    const next={...before};
    for(const key of allowed) if(key!=='notes' && Object.prototype.hasOwnProperty.call(input,key)) next[key]=key==='metadata'?(input[key]||{}):input[key];
    next.title=clean(next.title,255); next.category=clean(next.category,60); next.body=clean(next.body,100000); next.source_reference=clean(next.source_reference,500); next.effective_from=clean(next.effective_from,10); next.effective_to=clean(next.effective_to,10); next.version=clean(next.version,40); next.status=clean(next.status,15);
    if(!next.title||!next.category||!next.body||!next.source_reference)return res.status(400).json({ok:false,error:'title, category, body and source_reference are required'});
    if(!STATUSES.includes(next.status))return res.status(400).json({ok:false,error:'Invalid status'});
    if(!validDateWindow(next.effective_from,next.effective_to))return res.status(400).json({ok:false,error:'effective_to must be on or after effective_from'});
    const row=await db.one(`UPDATE municipal_knowledge_items SET title=$2,category=$3,body=$4,source_reference=$5,effective_from=$6,effective_to=$7,version=$8,status=$9,metadata=$10 WHERE knowledge_id=$1 RETURNING *`,[id,next.title,next.category,next.body,next.source_reference,next.effective_from,next.effective_to,next.version,next.status,next.metadata||{}]);
    const action=eventAction(before,row);
    await writeEvent(id,action,req.user.user_id,before,row,clean(input.notes,2000),req);
    await auditLog(req.user.user_id,`KNOWLEDGE_ITEM_${action}`,'municipal_knowledge_item',id,true,{status_before:before.status,status_after:row.status,version:row.version},req);
    res.json({ok:true,data:row,action});
  } catch(err) {
    logger.error('Knowledge governance update error',{error:err.message});
    res.status(500).json({ok:false,error:'Internal server error'});
  }
});

module.exports=router;
