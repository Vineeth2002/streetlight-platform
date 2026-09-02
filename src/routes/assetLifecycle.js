'use strict';

const express = require('express');
const db = require('../../config/database');
const logger = require('../utils/logger');
const { requireAuth, requireRole, auditLog } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
const READ = ['SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','CONTRACTOR','FIELD_ENGINEER','READ_ONLY'];
const WRITE = ['SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','FIELD_ENGINEER'];
const TYPES = ['INSTALLED','COMMISSIONED','MAINTENANCE','REPAIR','REPLACEMENT','INSPECTION','WARRANTY','DECOMMISSIONED','RECOMMISSIONED','OTHER'];

async function poleScope(user, poleId) {
  const row = await db.oneOrNone(`SELECT p.pole_id,p.pole_number,p.current_status,p.installation_date,p.last_maintenance,jb.ward_id,w.ward_number,z.zone_id,z.zone_name FROM poles p JOIN junction_boxes jb ON jb.cabinet_id=p.cabinet_id JOIN wards w ON w.ward_id=jb.ward_id JOIN zones z ON z.zone_id=w.zone_id WHERE p.pole_id=$1`, [poleId]);
  if (!row) return {row:null,allowed:false};
  if (user.role === 'GVMC_EE' && row.zone_id !== user.zone_id) return {row,allowed:false};
  if (user.role === 'CONTRACTOR') {
    const own = await db.oneOrNone(`SELECT 1 FROM work_orders WHERE pole_id=$1 AND contractor_id=$2 LIMIT 1`, [poleId,user.contractor_id]);
    if (!own) return {row,allowed:false};
  }
  if (user.role === 'FIELD_ENGINEER') {
    const assigned = await db.oneOrNone(`SELECT 1 FROM work_orders WHERE pole_id=$1 AND assigned_to=$2 LIMIT 1`, [poleId,user.user_id]);
    if (!assigned) return {row,allowed:false};
  }
  return {row,allowed:true};
}

router.get('/:poleId', requireRole(...READ), async (req,res) => {
  const poleId=Number.parseInt(req.params.poleId,10);
  if(!Number.isInteger(poleId)) return res.status(400).json({ok:false,error:'Invalid pole id'});
  try {
    const {row,allowed}=await poleScope(req.user,poleId);
    if(!row || !allowed)return res.status(404).json({ok:false,error:'Asset not found'});
    const [events,assignments,reliability]=await Promise.all([
      db.manyOrNone(`SELECT e.lifecycle_event_id,e.event_type,e.event_at,e.work_order_id,e.contract_id,e.actor_id,e.description,e.metadata,e.created_at,u.full_name AS actor_name FROM asset_lifecycle_events e LEFT JOIN users u ON u.user_id=e.actor_id WHERE e.pole_id=$1 ORDER BY e.event_at DESC,e.lifecycle_event_id DESC LIMIT 500`,[poleId]),
      db.manyOrNone(`SELECT a.assignment_id,a.contract_id,a.segment_id,a.installed_at,a.warranty_start,a.warranty_end,a.assignment_status,mc.contract_number,mc.title,mc.contractor_id,c.company_name FROM contract_asset_assignments a JOIN municipal_contracts mc ON mc.contract_id=a.contract_id JOIN contractors c ON c.contractor_id=mc.contractor_id WHERE a.pole_id=$1 ORDER BY a.warranty_start DESC`,[poleId]),
      db.oneOrNone(`SELECT * FROM asset_reliability_snapshots WHERE pole_id=$1 ORDER BY as_of DESC LIMIT 1`,[poleId])
    ]);
    const visibleAssignments=req.user.role==='CONTRACTOR'?assignments.filter(a=>a.contractor_id===req.user.contractor_id):assignments;
    res.json({ok:true,asset:row,events,contract_assignments:visibleAssignments,reliability:reliability||null});
  } catch(err){logger.error('Asset lifecycle detail error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

router.post('/:poleId/events', requireRole(...WRITE), async (req,res) => {
  const poleId=Number.parseInt(req.params.poleId,10);
  if(!Number.isInteger(poleId))return res.status(400).json({ok:false,error:'Invalid pole id'});
  const b=req.body||{}; const eventType=String(b.event_type||'').trim();
  if(!TYPES.includes(eventType))return res.status(400).json({ok:false,error:`event_type must be one of: ${TYPES.join(', ')}`});
  if(eventType==='DECOMMISSIONED' && req.user.role==='FIELD_ENGINEER')return res.status(403).json({ok:false,error:'Only GVMC governance roles may record decommissioning'});
  const eventAt=b.event_at?new Date(b.event_at):new Date();
  if(Number.isNaN(eventAt.getTime()))return res.status(400).json({ok:false,error:'Invalid event_at'});
  try {
    const {row,allowed}=await poleScope(req.user,poleId);
    if(!row || !allowed)return res.status(404).json({ok:false,error:'Asset not found'});
    const workOrderId=b.work_order_id==null?null:Number.parseInt(b.work_order_id,10);
    const contractId=b.contract_id==null?null:Number.parseInt(b.contract_id,10);
    if(workOrderId!==null && !Number.isInteger(workOrderId))return res.status(400).json({ok:false,error:'Invalid work_order_id'});
    if(contractId!==null && !Number.isInteger(contractId))return res.status(400).json({ok:false,error:'Invalid contract_id'});
    if(workOrderId!==null){const wo=await db.oneOrNone(`SELECT work_order_id FROM work_orders WHERE work_order_id=$1 AND pole_id=$2`,[workOrderId,poleId]);if(!wo)return res.status(400).json({ok:false,error:'Work order does not belong to this asset'});}
    if(contractId!==null){const c=await db.oneOrNone(`SELECT contract_id FROM municipal_contracts WHERE contract_id=$1`,[contractId]);if(!c)return res.status(400).json({ok:false,error:'Contract not found'});}
    const event=await db.one(`INSERT INTO asset_lifecycle_events(pole_id,event_type,event_at,work_order_id,contract_id,actor_id,description,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[poleId,eventType,eventAt.toISOString(),workOrderId,contractId,req.user.user_id,b.description?String(b.description).slice(0,4000):null,b.metadata||{}]);
    await auditLog(req.user.user_id,'ASSET_LIFECYCLE_EVENT_CREATED','asset_lifecycle_events',event.lifecycle_event_id,true,{pole_id:poleId,event_type:eventType},req);
    res.status(201).json({ok:true,data:event,advisory:'Lifecycle history recorded; operational pole status is unchanged.'});
  }catch(err){logger.error('Asset lifecycle event error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

router.get('/summary/city', requireRole(...READ), async (req,res)=>{
  try { const rows=await db.manyOrNone(`SELECT * FROM v_asset_lifecycle_summary ORDER BY lifecycle_event_count DESC LIMIT 500`); res.json({ok:true,data:rows}); }
  catch(err){logger.error('Asset lifecycle summary error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

module.exports=router;
