'use strict';

const express = require('express');
const db = require('../../config/database');
const logger = require('../utils/logger');
const { requireAuth, requireRole, auditLog } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const READ = ['SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','CONTRACTOR','FIELD_ENGINEER','READ_ONLY'];
const WRITE = ['SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE'];

function scopeAssignment(user, params, conditions, alias = 'a') {
  if (user.role === 'GVMC_EE') {
    params.push(user.zone_id);
    conditions.push(`EXISTS (SELECT 1 FROM contract_segments cs WHERE cs.segment_id=${alias}.segment_id AND cs.zone_id=$${params.length})`);
  }
  if (user.role === 'CONTRACTOR') {
    params.push(user.contractor_id);
    conditions.push(`EXISTS (SELECT 1 FROM municipal_contracts mc WHERE mc.contract_id=${alias}.contract_id AND mc.contractor_id=$${params.length})`);
  }
  if (user.role === 'FIELD_ENGINEER') {
    params.push(user.user_id);
    conditions.push(`EXISTS (SELECT 1 FROM work_orders wo WHERE wo.pole_id=${alias}.pole_id AND wo.assigned_to=$${params.length})`);
  }
}

router.get('/summary', requireRole(...READ), async (req,res) => {
  try {
    const params=[], conditions=[];
    scopeAssignment(req.user,params,conditions,'a');
    const where=conditions.length?`WHERE ${conditions.join(' AND ')}`:'';
    const row=await db.one(`
      SELECT COUNT(*)::int AS assigned_assets,
        COUNT(*) FILTER (WHERE a.warranty_start <= NOW() AND (a.warranty_end IS NULL OR a.warranty_end >= NOW()))::int AS assets_under_warranty,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM work_orders wo WHERE wo.pole_id=a.pole_id AND wo.reported_timestamp >= a.warranty_start AND (a.warranty_end IS NULL OR wo.reported_timestamp <= a.warranty_end)))::int AS warranty_failure_assets,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM work_orders wo WHERE wo.pole_id=a.pole_id AND wo.reported_timestamp >= a.warranty_start AND (a.warranty_end IS NULL OR wo.reported_timestamp <= a.warranty_end)))::int AS warranty_repair_assets
      FROM contract_asset_assignments a ${where}` ,params);
    const contractorConditions=conditions.slice();
    const contractors=await db.manyOrNone(`
      SELECT c.contractor_id,c.company_name,COUNT(DISTINCT a.pole_id)::int assigned_assets,
        COUNT(DISTINCT a.pole_id) FILTER (WHERE EXISTS (SELECT 1 FROM work_orders wo WHERE wo.pole_id=a.pole_id AND wo.reported_timestamp BETWEEN a.warranty_start AND COALESCE(a.warranty_end,'infinity'::timestamptz)))::int warranty_failure_assets,
        ROUND(100.0 * COUNT(DISTINCT a.pole_id) FILTER (WHERE NOT EXISTS (SELECT 1 FROM work_orders wo WHERE wo.pole_id=a.pole_id AND wo.reported_timestamp BETWEEN a.warranty_start AND COALESCE(a.warranty_end,'infinity'::timestamptz))) / NULLIF(COUNT(DISTINCT a.pole_id),0),2) AS durability_rate_pct
      FROM contract_asset_assignments a JOIN municipal_contracts mc ON mc.contract_id=a.contract_id JOIN contractors c ON c.contractor_id=mc.contractor_id
      ${contractorConditions.length?'WHERE '+contractorConditions.join(' AND '):''} GROUP BY c.contractor_id,c.company_name ORDER BY durability_rate_pct ASC NULLS LAST`,params);
    res.json({ok:true,methodology:'Warranty-linked asset durability; failures are work orders reported inside the recorded warranty window. No automatic penalty is created.',summary:row,contractors});
  } catch(err) { logger.error('Durability summary error',{error:err.message}); res.status(500).json({ok:false,error:'Internal server error'}); }
});

router.get('/:poleId', requireRole(...READ), async (req,res) => {
  const poleId=Number.parseInt(req.params.poleId,10);
  if(!Number.isInteger(poleId)) return res.status(400).json({ok:false,error:'Invalid pole id'});
  try {
    const params=[poleId],conditions=[];
    if(req.user.role==='GVMC_EE'){params.push(req.user.zone_id);conditions.push(`EXISTS (SELECT 1 FROM junction_boxes jb JOIN wards w ON w.ward_id=jb.ward_id WHERE jb.cabinet_id=p.cabinet_id AND w.zone_id=$${params.length})`);}
    if(req.user.role==='CONTRACTOR'){params.push(req.user.contractor_id);conditions.push(`EXISTS (SELECT 1 FROM contract_asset_assignments ax JOIN municipal_contracts mc ON mc.contract_id=ax.contract_id WHERE ax.pole_id=p.pole_id AND mc.contractor_id=$${params.length})`);}
    if(req.user.role==='FIELD_ENGINEER'){params.push(req.user.user_id);conditions.push(`EXISTS (SELECT 1 FROM work_orders wx WHERE wx.pole_id=p.pole_id AND wx.assigned_to=$${params.length})`);}
    const pole=await db.oneOrNone(`SELECT p.pole_id,p.pole_number,p.current_status,p.installation_date FROM poles p WHERE p.pole_id=$1 ${conditions.length?'AND '+conditions.join(' AND '):''}` ,params);
    if(!pole)return res.status(404).json({ok:false,error:'Pole not found'});
    const assignments=await db.manyOrNone(`SELECT a.*,mc.contract_number,mc.title,mc.contractor_id,c.company_name,cs.segment_name,cs.zone_id,cs.ward_id,
      EXISTS (SELECT 1 FROM work_orders wo WHERE wo.pole_id=a.pole_id AND wo.reported_timestamp>=a.warranty_start AND (a.warranty_end IS NULL OR wo.reported_timestamp<=a.warranty_end)) AS warranty_breach
      FROM contract_asset_assignments a JOIN municipal_contracts mc ON mc.contract_id=a.contract_id JOIN contractors c ON c.contractor_id=mc.contractor_id LEFT JOIN contract_segments cs ON cs.segment_id=a.segment_id
      WHERE a.pole_id=$1 ORDER BY a.warranty_start DESC`,[poleId]);
    if(req.user.role==='CONTRACTOR' && assignments.every(a=>a.contractor_id!==req.user.contractor_id))return res.status(403).json({ok:false,error:'Access denied'});
    const visibleAssignments=req.user.role==='CONTRACTOR'?assignments.filter(a=>a.contractor_id===req.user.contractor_id):assignments;
    const orders=await db.manyOrNone(`SELECT work_order_id,fault_category,ticket_status,reported_timestamp,resolved_timestamp,contractor_id,penalty_deducted FROM work_orders WHERE pole_id=$1 ${req.user.role==='CONTRACTOR'?'AND contractor_id=$2':''} ORDER BY reported_timestamp DESC LIMIT 100`,req.user.role==='CONTRACTOR'?[poleId,req.user.contractor_id]:[poleId]);
    const warrantyFailures=orders.filter(o=>visibleAssignments.some(a=>new Date(o.reported_timestamp)>=new Date(a.warranty_start)&&(!a.warranty_end||new Date(o.reported_timestamp)<=new Date(a.warranty_end))));
    res.json({ok:true,asset:pole,assignments:visibleAssignments,work_orders:orders,warranty_failures:warrantyFailures,durability:{assignment_count:visibleAssignments.length,warranty_failure_count:warrantyFailures.length,repeat_repair_rate_pct:orders.length?Number((warrantyFailures.length/orders.length*100).toFixed(2)):0}});
  } catch(err) { logger.error('Durability detail error',{error:err.message}); res.status(500).json({ok:false,error:'Internal server error'}); }
});

router.post('/assignments', requireRole(...WRITE), async (req,res) => {
  const {contract_id,pole_id,segment_id,installed_at,warranty_start,source_reference,metadata}=req.body||{};
  if(!Number.isInteger(Number(contract_id))||!Number.isInteger(Number(pole_id))||!warranty_start)return res.status(400).json({ok:false,error:'contract_id, pole_id and warranty_start are required'});
  try {
    const contract=await db.oneOrNone(`SELECT contract_id,contractor_id,warranty_days,start_date,end_date FROM municipal_contracts WHERE contract_id=$1`,[contract_id]);
    const pole=await db.oneOrNone(`SELECT p.pole_id,jb.ward_id,w.zone_id FROM poles p JOIN junction_boxes jb ON jb.cabinet_id=p.cabinet_id JOIN wards w ON w.ward_id=jb.ward_id WHERE p.pole_id=$1`,[pole_id]);
    if(!contract||!pole)return res.status(404).json({ok:false,error:'Contract or pole not found'});
    if(req.user.role==='GVMC_EE'){
      if(pole.zone_id!==req.user.zone_id)return res.status(403).json({ok:false,error:'Pole outside assigned zone'});
      if(segment_id){const s=await db.oneOrNone(`SELECT segment_id FROM contract_segments WHERE segment_id=$1 AND contract_id=$2 AND zone_id=$3`,[segment_id,contract_id,req.user.zone_id]);if(!s)return res.status(403).json({ok:false,error:'Segment outside assigned zone or contract'});}
    }
    if(segment_id){const s=await db.oneOrNone(`SELECT segment_id FROM contract_segments WHERE segment_id=$1 AND contract_id=$2 AND zone_id=$3`,[segment_id,contract_id,pole.zone_id]);if(!s)return res.status(400).json({ok:false,error:'Segment does not match contract and pole zone'});}
    const start=new Date(warranty_start);
    if(Number.isNaN(start.getTime()))return res.status(400).json({ok:false,error:'Invalid warranty_start'});
    const end=contract.warranty_days==null?null:new Date(start.getTime()+Number(contract.warranty_days)*86400000).toISOString();
    const row=await db.one(`INSERT INTO contract_asset_assignments(contract_id,segment_id,pole_id,installed_at,warranty_start,warranty_end,source_reference,metadata,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[contract_id,segment_id||null,pole_id,installed_at||null,start.toISOString(),end,source_reference||null,metadata||{},req.user.user_id]);
    await auditLog(req.user.user_id,'CONTRACT_ASSET_ASSIGNED','contract_asset_assignment',row.assignment_id,true,{contract_id,pole_id,segment_id,warranty_start:row.warranty_start,warranty_end:row.warranty_end},req);
    res.status(201).json({ok:true,data:row,advisory:'Warranty linkage only; this action does not create or assess a penalty.'});
  } catch(err) { logger.error('Durability assignment error',{error:err.message}); if(err.code==='23505')return res.status(409).json({ok:false,error:'This contract/pole/warranty assignment already exists'}); res.status(500).json({ok:false,error:'Internal server error'}); }
});

module.exports=router;
