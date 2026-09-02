'use strict';

const express = require('express');
const db = require('../../config/database');
const logger = require('../utils/logger');
const { requireAuth, requireRole, auditLog } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const READ_ROLES = ['SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','READ_ONLY'];
const WRITE_ROLES = ['SUPER_ADMIN','GVMC_COMMISSIONER'];
const STATUSES = ['PLANNED','TENDERED','EVALUATION','AWARDED','CANCELLED','CLOSED'];

function zoneCondition(user, params) {
  if (user.role !== 'GVMC_EE') return { sql: '', params };
  params.push(user.zone_id);
  return {
    sql: `AND EXISTS (SELECT 1 FROM contract_segments cs WHERE cs.contract_id=c.contract_id AND cs.zone_id=$${params.length})`,
    params
  };
}

router.get('/', requireRole(...READ_ROLES), async (req,res) => {
  try {
    const params=[];
    const scope=zoneCondition(req.user,params);
    const rows=await db.manyOrNone(`
      SELECT pr.*, c.contract_number, c.title AS contract_title,
             c.contractor_id, co.company_name,
             COALESCE((pr.estimated_value_inr-pr.awarded_value_inr),0) AS value_variance_inr
      FROM procurement_records pr
      LEFT JOIN municipal_contracts c ON c.contract_id=pr.contract_id
      LEFT JOIN contractors co ON co.contractor_id=c.contractor_id
      WHERE 1=1 ${scope.sql}
      ORDER BY COALESCE(pr.award_date,pr.notice_date) DESC NULLS LAST, pr.procurement_id DESC
      LIMIT 500`, params);
    const totals=await db.one(`
      SELECT COUNT(*)::int AS total_records,
             COALESCE(SUM(estimated_value_inr),0) AS estimated_value_inr,
             COALESCE(SUM(awarded_value_inr),0) AS awarded_value_inr
      FROM procurement_records pr
      LEFT JOIN municipal_contracts c ON c.contract_id=pr.contract_id
      WHERE 1=1 ${scope.sql}`, params);
    res.json({ok:true,totals,data:rows});
  } catch(err) {
    logger.error('Procurement list error',{error:err.message});
    res.status(500).json({ok:false,error:'Internal server error'});
  }
});

router.get('/:id', requireRole(...READ_ROLES), async (req,res) => {
  const id=Number.parseInt(req.params.id,10);
  if(!Number.isInteger(id)) return res.status(400).json({ok:false,error:'Invalid procurement id'});
  try {
    const params=[id];
    const scope=zoneCondition(req.user,params);
    const row=await db.oneOrNone(`
      SELECT pr.*, c.contract_number,c.title AS contract_title,c.contractor_id,
             co.company_name,
             COALESCE(pr.estimated_value_inr-pr.awarded_value_inr,0) AS value_variance_inr
      FROM procurement_records pr
      LEFT JOIN municipal_contracts c ON c.contract_id=pr.contract_id
      LEFT JOIN contractors co ON co.contractor_id=c.contractor_id
      WHERE pr.procurement_id=$1 ${scope.sql}`,params);
    if(!row) return res.status(404).json({ok:false,error:'Procurement record not found'});
    const events=await db.manyOrNone(`SELECT event_id,from_status,to_status,changed_by,changed_at,notes,metadata FROM procurement_events WHERE procurement_id=$1 ORDER BY changed_at DESC,event_id DESC`,[id]);
    res.json({ok:true,data:row,events});
  } catch(err) {
    logger.error('Procurement detail error',{error:err.message});
    res.status(500).json({ok:false,error:'Internal server error'});
  }
});

router.post('/', requireRole(...WRITE_ROLES), async (req,res) => {
  const b=req.body||{};
  const status=b.status || 'PLANNED';
  if(!b.contract_id || !Number.isInteger(Number(b.contract_id))) return res.status(400).json({ok:false,error:'contract_id is required'});
  if(!STATUSES.includes(status)) return res.status(400).json({ok:false,error:'Invalid procurement status'});
  if(b.estimated_value_inr != null && Number(b.estimated_value_inr)<0) return res.status(400).json({ok:false,error:'estimated_value_inr must be non-negative'});
  if(b.awarded_value_inr != null && Number(b.awarded_value_inr)<0) return res.status(400).json({ok:false,error:'awarded_value_inr must be non-negative'});
  try {
    const contract=await db.oneOrNone('SELECT contract_id FROM municipal_contracts WHERE contract_id=$1',[Number(b.contract_id)]);
    if(!contract) return res.status(400).json({ok:false,error:'Contract not found'});
    const row=await db.one(`INSERT INTO procurement_records(contract_id,tender_number,procurement_method,notice_date,award_date,estimated_value_inr,awarded_value_inr,status,metadata,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[Number(b.contract_id),b.tender_number||null,b.procurement_method||null,b.notice_date||null,b.award_date||null,b.estimated_value_inr==null?null:Number(b.estimated_value_inr),b.awarded_value_inr==null?null:Number(b.awarded_value_inr),status,b.metadata||{},req.user.user_id]);
    await db.none(`INSERT INTO procurement_events(procurement_id,from_status,to_status,changed_by,notes,metadata) VALUES($1,NULL,$2,$3,$4,$5)`,[row.procurement_id,status,req.user.user_id,'Procurement record created',{}]);
    await auditLog(req.user.user_id,'PROCUREMENT_CREATED','procurement_record',row.procurement_id,true,{contract_id:row.contract_id,status:row.status},req);
    res.status(201).json({ok:true,data:row});
  } catch(err) {
    if(err.code==='23505') return res.status(409).json({ok:false,error:'Tender number already exists'});
    logger.error('Procurement create error',{error:err.message});
    res.status(500).json({ok:false,error:'Internal server error'});
  }
});

router.patch('/:id', requireRole(...WRITE_ROLES), async (req,res) => {
  const id=Number.parseInt(req.params.id,10);
  if(!Number.isInteger(id)) return res.status(400).json({ok:false,error:'Invalid procurement id'});
  const b=req.body||{};
  const allowed=['tender_number','procurement_method','notice_date','award_date','estimated_value_inr','awarded_value_inr','metadata'];
  const keys=Object.keys(b).filter(k=>allowed.includes(k));
  if(!keys.length && b.status==null) return res.status(400).json({ok:false,error:'No permitted fields supplied'});
  if(b.status!=null && !STATUSES.includes(b.status)) return res.status(400).json({ok:false,error:'Invalid procurement status'});
  for(const k of ['estimated_value_inr','awarded_value_inr']) if(b[k]!=null && Number(b[k])<0) return res.status(400).json({ok:false,error:`${k} must be non-negative`});
  try {
    const current=await db.oneOrNone('SELECT * FROM procurement_records WHERE procurement_id=$1',[id]);
    if(!current) return res.status(404).json({ok:false,error:'Procurement record not found'});
    const assignments=[]; const values=[];
    for(const k of keys){values.push(k==='estimated_value_inr'||k==='awarded_value_inr'?Number(b[k]):b[k]);assignments.push(`${k}=$${values.length}`);}
    if(b.status!=null){values.push(b.status);assignments.push(`status=$${values.length}`);}
    values.push(id);
    const row=await db.one(`UPDATE procurement_records SET ${assignments.join(',')} WHERE procurement_id=$${values.length} RETURNING *`,values);
    if(b.status!=null && b.status!==current.status){
      await db.none(`INSERT INTO procurement_events(procurement_id,from_status,to_status,changed_by,notes,metadata) VALUES($1,$2,$3,$4,$5,$6)`,[id,current.status,b.status,req.user.user_id,b.notes||null,b.metadata||{}]);
    }
    await auditLog(req.user.user_id,'PROCUREMENT_UPDATED','procurement_record',id,true,{changed_fields:[...keys,...(b.status!=null?['status']:[])],from_status:current.status,to_status:row.status},req);
    res.json({ok:true,data:row});
  } catch(err) {
    if(err.code==='23505') return res.status(409).json({ok:false,error:'Tender number already exists'});
    logger.error('Procurement update error',{error:err.message});
    res.status(500).json({ok:false,error:'Internal server error'});
  }
});

module.exports=router;
