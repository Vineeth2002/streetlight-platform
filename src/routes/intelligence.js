'use strict';

const express = require('express');
const db = require('../../config/database');
const logger = require('../utils/logger');
const { requireAuth, requireRole, auditLog } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function scopePole(user, params, conditions, alias = 'p') {
  if (user.role === 'GVMC_EE') {
    params.push(user.zone_id);
    conditions.push(`EXISTS (SELECT 1 FROM junction_boxes jb0 JOIN wards w0 ON w0.ward_id=jb0.ward_id WHERE jb0.cabinet_id=${alias}.cabinet_id AND w0.zone_id=$${params.length})`);
  }
  if (user.role === 'CONTRACTOR') {
    params.push(user.contractor_id);
    conditions.push(`EXISTS (SELECT 1 FROM work_orders wo0 WHERE wo0.pole_id=${alias}.pole_id AND wo0.contractor_id=$${params.length})`);
  }
  if (user.role === 'FIELD_ENGINEER') {
    params.push(user.user_id);
    conditions.push(`EXISTS (SELECT 1 FROM work_orders wo0 WHERE wo0.pole_id=${alias}.pole_id AND wo0.assigned_to=$${params.length})`);
  }
}

function latestReliabilitySql(extraWhere = '') {
  return `
    SELECT DISTINCT ON (ars.pole_id)
      ars.pole_id, ars.as_of, ars.repair_count_90d, ars.repair_count_365d,
      ars.recurrence_count_90d, ars.mttr_hours_365d, ars.mtbf_hours_365d,
      ars.days_since_last_repair, ars.last_failure_at, ars.dominant_fault_category,
      ars.risk_score, ars.risk_band, ars.factors
    FROM asset_reliability_snapshots ars
    JOIN poles p ON p.pole_id=ars.pole_id
    ${extraWhere}
    ORDER BY ars.pole_id, ars.as_of DESC`;
}

router.get('/reliability/summary', requireRole('SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','CONTRACTOR','FIELD_ENGINEER','READ_ONLY'), async (req, res) => {
  try {
    const params = [], conditions = [];
    scopePole(req.user, params, conditions, 'p');
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const latest = latestReliabilitySql(where);
    const [distribution, data] = await Promise.all([
      db.manyOrNone(`SELECT risk_band,COUNT(*)::int count FROM (${latest}) r GROUP BY risk_band ORDER BY risk_band`, params),
      db.manyOrNone(`SELECT r.* FROM (${latest}) r ORDER BY r.risk_score DESC,r.repair_count_90d DESC LIMIT 500`, params)
    ]);
    res.json({ ok:true, generated_at:new Date().toISOString(), methodology:'Deterministic advisory score from daily reliability snapshots; explainable from repair recurrence and resolution history.', distribution, data });
  } catch (err) {
    logger.error('Reliability summary error',{error:err.message});
    res.status(500).json({ok:false,error:'Internal server error'});
  }
});

router.get('/reliability/:poleId', requireRole('SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','CONTRACTOR','FIELD_ENGINEER','READ_ONLY'), async (req,res)=>{
  const poleId=Number.parseInt(req.params.poleId,10);
  if(!Number.isInteger(poleId)) return res.status(400).json({ok:false,error:'Invalid pole id'});
  try{
    const params=[poleId],conditions=[];
    scopePole(req.user,params,conditions,'p');
    const scope=conditions.length?`AND ${conditions.join(' AND ')}`:'';
    const row=await db.oneOrNone(`SELECT p.pole_id,p.pole_number,p.current_status,p.luminaire_wattage,p.installation_date,r.* FROM poles p LEFT JOIN LATERAL (SELECT * FROM asset_reliability_snapshots ars WHERE ars.pole_id=p.pole_id ORDER BY ars.as_of DESC LIMIT 1) r ON TRUE WHERE p.pole_id=$1 ${scope}`,params);
    if(!row) return res.status(404).json({ok:false,error:'Pole not found'});
    const [orders,telemetry]=await Promise.all([
      db.manyOrNone(`SELECT work_order_id,fault_category,ticket_status,reported_timestamp,resolved_timestamp,resolution_notes FROM work_orders WHERE pole_id=$1 ORDER BY reported_timestamp DESC LIMIT 50`,[poleId]),
      db.manyOrNone(`SELECT time_bucket('1 day',timestamp) AS day,ROUND(AVG(voltage_rms),2) voltage_avg,ROUND(AVG(current_rms),3) current_avg,ROUND(AVG(active_power),2) power_avg,ROUND(AVG(power_factor),3) power_factor_avg,ROUND(AVG(temperature),2) temperature_avg FROM node_telemetry WHERE pole_number=$2 AND timestamp>=NOW()-INTERVAL '30 days' GROUP BY 1 ORDER BY 1 DESC LIMIT 30`,[poleId,row.pole_number])
    ]);
    res.json({ok:true,asset:row,work_orders:orders,telemetry_30d:telemetry});
  }catch(err){logger.error('Reliability detail error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

router.get('/contracts', requireRole('SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','CONTRACTOR','READ_ONLY'), async (req,res)=>{
  try{
    const params=[],conditions=[];
    if(req.user.role==='GVMC_EE'){params.push(req.user.zone_id);conditions.push(`EXISTS (SELECT 1 FROM contract_segments cs0 WHERE cs0.contract_id=c.contract_id AND cs0.zone_id=$${params.length})`);}
    if(req.user.role==='CONTRACTOR'){params.push(req.user.contractor_id);conditions.push(`c.contractor_id=$${params.length}`);}
    const rows=await db.manyOrNone(`SELECT c.*,co.company_name,COUNT(cs.segment_id)::int segment_count FROM municipal_contracts c JOIN contractors co ON co.contractor_id=c.contractor_id LEFT JOIN contract_segments cs ON cs.contract_id=c.contract_id ${conditions.length?'WHERE '+conditions.join(' AND '):''} GROUP BY c.contract_id,co.company_name ORDER BY c.end_date NULLS LAST,c.contract_id DESC`,params);
    res.json({ok:true,data:rows});
  }catch(err){logger.error('Contract intelligence error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

router.get('/contracts/:id', requireRole('SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','CONTRACTOR','READ_ONLY'), async(req,res)=>{
  const id=Number.parseInt(req.params.id,10); if(!Number.isInteger(id)) return res.status(400).json({ok:false,error:'Invalid contract id'});
  try{
    const c=await db.oneOrNone(`SELECT c.*,co.company_name FROM municipal_contracts c JOIN contractors co ON co.contractor_id=c.contractor_id WHERE c.contract_id=$1`,[id]);
    if(!c) return res.status(404).json({ok:false,error:'Contract not found'});
    if(req.user.role==='CONTRACTOR'&&c.contractor_id!==req.user.contractor_id)return res.status(403).json({ok:false,error:'Access denied'});
    if(req.user.role==='GVMC_EE'){
      const allowed=await db.oneOrNone(`SELECT 1 FROM contract_segments WHERE contract_id=$1 AND zone_id=$2 LIMIT 1`,[id,req.user.zone_id]);
      if(!allowed)return res.status(403).json({ok:false,error:'Access denied'});
    }
    const [segments,orders,penalties]=await Promise.all([
      db.manyOrNone(`SELECT segment_id,segment_name,zone_id,ward_id,target_asset_count FROM contract_segments WHERE contract_id=$1 ORDER BY segment_id`,[id]),
      db.manyOrNone(`SELECT wo.work_order_id,wo.pole_id,wo.fault_category,wo.ticket_status,wo.reported_timestamp,wo.resolved_timestamp,wo.penalty_deducted FROM work_orders wo WHERE wo.contractor_id=$2 AND wo.reported_timestamp BETWEEN COALESCE($1::date,'1900-01-01') AND COALESCE(($3::date+INTERVAL '1 day'),'2999-01-01') ORDER BY wo.reported_timestamp DESC LIMIT 500`,[c.start_date,c.contractor_id,c.end_date]),
      db.manyOrNone(`SELECT l.* FROM contractor_penalty_ledger l WHERE l.contractor_id=$1 ORDER BY assessed_at DESC LIMIT 100`,[c.contractor_id])
    ]);
    res.json({ok:true,contract:c,segments,execution:orders,penalties});
  }catch(err){logger.error('Contract detail error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

router.get('/procurement', requireRole('SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','READ_ONLY'), async(req,res)=>{
  try{
    const rows=await db.manyOrNone(`SELECT pr.*,c.contract_number,co.company_name FROM procurement_records pr LEFT JOIN municipal_contracts c ON c.contract_id=pr.contract_id LEFT JOIN contractors co ON co.contractor_id=c.contractor_id ORDER BY COALESCE(pr.award_date,pr.notice_date) DESC NULLS LAST,pr.procurement_id DESC LIMIT 500`);
    const totals=await db.one(`SELECT COUNT(*)::int total_records,COALESCE(SUM(estimated_value_inr),0) estimated_value_inr,COALESCE(SUM(awarded_value_inr),0) awarded_value_inr FROM procurement_records`);
    res.json({ok:true,totals,data:rows});
  }catch(err){logger.error('Procurement intelligence error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

router.get('/finance', requireRole('SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','CONTRACTOR','READ_ONLY'), async(req,res)=>{
  try{
    const params=[],where=[];
    if(req.user.role==='CONTRACTOR'){params.push(req.user.contractor_id);where.push(`c.contractor_id=$${params.length}`);}
    if(req.user.role==='GVMC_EE'){params.push(req.user.zone_id);where.push(`c.assigned_zone_id=$${params.length}`);}
    const rows=await db.manyOrNone(`SELECT c.contractor_id,c.company_name,c.monthly_invoice_base,c.total_penalty_mtd,COALESCE(SUM(l.amount_inr),0) ledger_penalties,ROUND(c.monthly_invoice_base-c.total_penalty_mtd,2) net_payable_basis FROM contractors c LEFT JOIN contractor_penalty_ledger l ON l.contractor_id=c.contractor_id ${where.length?'WHERE '+where.join(' AND '):''} GROUP BY c.contractor_id ORDER BY c.total_penalty_mtd DESC`,params);
    res.json({ok:true,data:rows});
  }catch(err){logger.error('Finance intelligence error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

router.get('/spatial/zones', requireRole('SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','READ_ONLY'), async(req,res)=>{
  try{
    const params=[],where=[];
    if(req.user.role==='GVMC_EE'){params.push(req.user.zone_id);where.push(`g.zone_id=$${params.length}`);}
    const rows=await db.manyOrNone(`SELECT g.*,COUNT(wo.work_order_id) FILTER(WHERE wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED'))::int open_work_orders,COUNT(wo.work_order_id) FILTER(WHERE wo.ticket_status='SLA_VIOLATED')::int sla_violations FROM v_zone_glow_rates g LEFT JOIN wards w ON w.zone_id=g.zone_id LEFT JOIN junction_boxes jb ON jb.ward_id=w.ward_id LEFT JOIN poles p ON p.cabinet_id=jb.cabinet_id LEFT JOIN work_orders wo ON wo.pole_id=p.pole_id ${where.length?'WHERE '+where.join(' AND '):''} GROUP BY g.zone_id,g.zone_name,g.total_poles,g.operational_poles,g.glow_rate_pct,g.faulty_poles,g.day_burn_poles ORDER BY g.glow_rate_pct ASC`,params);
    res.json({ok:true,data:rows});
  }catch(err){logger.error('Spatial intelligence error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

router.get('/predictive/alerts', requireRole('SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','CONTRACTOR','FIELD_ENGINEER','READ_ONLY'), async(req,res)=>{
  try{
    const params=[],conditions=[];
    if(req.user.role==='GVMC_EE'){params.push(req.user.zone_id);conditions.push(`EXISTS (SELECT 1 FROM junction_boxes jb JOIN wards w ON w.ward_id=jb.ward_id WHERE jb.cabinet_id=p.cabinet_id AND w.zone_id=$${params.length})`);}
    if(req.user.role==='CONTRACTOR'){params.push(req.user.contractor_id);conditions.push(`EXISTS (SELECT 1 FROM work_orders wo WHERE wo.pole_id=p.pole_id AND wo.contractor_id=$${params.length})`);}
    if(req.user.role==='FIELD_ENGINEER'){params.push(req.user.user_id);conditions.push(`EXISTS (SELECT 1 FROM work_orders wo WHERE wo.pole_id=p.pole_id AND wo.assigned_to=$${params.length})`);}
    const rows=await db.manyOrNone(`SELECT a.alert_id,a.pole_id,p.pole_number,a.alert_type,a.severity,a.status,a.score,a.reason,a.evidence,a.generated_at FROM predictive_alerts a LEFT JOIN poles p ON p.pole_id=a.pole_id WHERE a.status IN ('OPEN','ACKNOWLEDGED') ${conditions.length?'AND '+conditions.join(' AND '):''} ORDER BY a.score DESC NULLS LAST,a.generated_at DESC LIMIT 500`,params);
    res.json({ok:true,advisory:true,data:rows});
  }catch(err){logger.error('Predictive alert error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

router.post('/predictive/alerts/:id/acknowledge', requireRole('SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE'), async(req,res)=>{
  const id=Number.parseInt(req.params.id,10); if(!Number.isInteger(id))return res.status(400).json({ok:false,error:'Invalid alert id'});
  try{
    const row=await db.oneOrNone(`UPDATE predictive_alerts SET status='ACKNOWLEDGED',acknowledged_at=NOW(),acknowledged_by=$2 WHERE alert_id=$1 AND status='OPEN' RETURNING *`,[id,req.user.user_id]);
    if(!row)return res.status(404).json({ok:false,error:'Open alert not found'});
    await auditLog(req.user.user_id,'PREDICTIVE_ALERT_ACKNOWLEDGED','predictive_alert',id,true,{pole_id:row.pole_id},req);
    res.json({ok:true,data:row});
  }catch(err){logger.error('Predictive alert acknowledgement error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

router.get('/knowledge', requireRole('SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','CONTRACTOR','FIELD_ENGINEER','READ_ONLY'), async(req,res)=>{
  try{
    const category=req.query.category?String(req.query.category).slice(0,60):null;
    const rows=await db.manyOrNone(`SELECT knowledge_id,title,category,body,source_reference,effective_from,effective_to,version,status,metadata,updated_at FROM municipal_knowledge_items WHERE status='ACTIVE' AND ($1::text IS NULL OR category=$1) ORDER BY category,title`,[category]);
    res.json({ok:true,data:rows});
  }catch(err){logger.error('Knowledge base error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

router.post('/knowledge', requireRole('SUPER_ADMIN','GVMC_COMMISSIONER'), async(req,res)=>{
  const {title,category,body,source_reference,effective_from,effective_to,version,metadata}=req.body||{};
  if(!title||!category||!body)return res.status(400).json({ok:false,error:'title, category and body are required'});
  try{
    const row=await db.one(`INSERT INTO municipal_knowledge_items(title,category,body,source_reference,effective_from,effective_to,version,metadata,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[String(title),String(category),String(body),source_reference||null,effective_from||null,effective_to||null,version||null,metadata||{},req.user.user_id]);
    await auditLog(req.user.user_id,'KNOWLEDGE_ITEM_CREATED','municipal_knowledge_item',row.knowledge_id,true,{category:row.category},req);
    res.status(201).json({ok:true,data:row});
  }catch(err){logger.error('Knowledge item create error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

router.get('/executive', requireRole('SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','READ_ONLY'), async(req,res)=>{
  try{
    const params=[],zoneWhere=[];
    if(req.user.role==='GVMC_EE'){params.push(req.user.zone_id);zoneWhere.push(`EXISTS (SELECT 1 FROM junction_boxes jb JOIN wards w ON w.ward_id=jb.ward_id WHERE jb.cabinet_id=p.cabinet_id AND w.zone_id=$${params.length})`);}
    const where=zoneWhere.length?`WHERE ${zoneWhere.join(' AND ')}`:'';
    const [city,reliability,finance,sla]=await Promise.all([
      db.one(`SELECT COUNT(*)::int total_assets,COUNT(*) FILTER(WHERE current_status='OPERATIONAL')::int operational,COUNT(*) FILTER(WHERE current_status='FAULTY')::int faulty,COUNT(*) FILTER(WHERE current_status='UNDER_REPAIR')::int under_repair,COUNT(*) FILTER(WHERE current_status='NO_SIGNAL')::int no_signal,COUNT(*) FILTER(WHERE current_status='DAY_BURN')::int day_burn FROM poles p ${where}`,params),
      db.one(`SELECT COUNT(*) FILTER(WHERE risk_band='CRITICAL')::int critical,COUNT(*) FILTER(WHERE risk_band='HIGH')::int high FROM (${latestReliabilitySql(where)}) r`,params),
      db.one(`SELECT COALESCE(SUM(monthly_invoice_base),0) invoice_base,COALESCE(SUM(total_penalty_mtd),0) penalties_mtd FROM contractors ${req.user.role==='GVMC_EE'?'WHERE assigned_zone_id=$1':''}`,req.user.role==='GVMC_EE'?[req.user.zone_id]:[]),
      db.one(`SELECT COUNT(*) FILTER(WHERE ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS'))::int open_orders,COUNT(*) FILTER(WHERE ticket_status='SLA_VIOLATED')::int sla_violations FROM work_orders wo JOIN poles p ON p.pole_id=wo.pole_id ${where}`,params)
    ]);
    res.json({ok:true,generated_at:new Date().toISOString(),city,reliability,finance,sla,advisory:'Executive intelligence aggregates existing operational facts; it does not alter SLA or glow-rate calculations.'});
  }catch(err){logger.error('Executive intelligence error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

router.get('/governance/data-quality', requireRole('SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','READ_ONLY'), async(req,res)=>{
  try{
    const params=[],zone=[];
    if(req.user.role==='GVMC_EE'){params.push(req.user.zone_id);zone.push(`EXISTS (SELECT 1 FROM junction_boxes jb JOIN wards w ON w.ward_id=jb.ward_id WHERE jb.cabinet_id=p.cabinet_id AND w.zone_id=$${params.length})`);}
    const where=zone.length?`AND ${zone.join(' AND ')}`:'';
    const [orphanNodes,missingGeo,unresolvedOwners,staleTelemetry]=await Promise.all([
      db.one(`SELECT COUNT(*)::int count FROM poles p WHERE node_id IS NULL AND current_status NOT IN ('DECOMMISSIONED') ${where}`,params),
      db.one(`SELECT COUNT(*)::int count FROM poles p WHERE geolocation IS NULL ${where}`,params),
      db.one(`SELECT COUNT(*)::int count FROM work_orders wo JOIN poles p ON p.pole_id=wo.pole_id WHERE wo.ticket_status IN ('ASSIGNED','IN_PROGRESS') AND wo.assigned_to IS NULL ${where}`,params),
      db.one(`SELECT COUNT(*)::int count FROM poles p WHERE p.node_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM node_telemetry t WHERE t.pole_number=p.pole_number AND t.timestamp>=NOW()-INTERVAL '15 minutes') AND p.current_status NOT IN ('DECOMMISSIONED') ${where}`,params)
    ]);
    res.json({ok:true,generated_at:new Date().toISOString(),checks:{poles_without_node:orphanNodes.count,poles_without_geolocation:missingGeo.count,active_orders_without_assignee:unresolvedOwners.count,nodes_without_recent_telemetry:staleTelemetry.count}});
  }catch(err){logger.error('Data quality error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

router.get('/reports/overview', requireRole('SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','CONTRACTOR','READ_ONLY'), async(req,res)=>{
  try{
    const [zones,contractors,faults]=await Promise.all([
      db.manyOrNone(`SELECT * FROM v_zone_glow_rates ${req.user.role==='GVMC_EE'?'WHERE zone_id=$1':''} ORDER BY glow_rate_pct ASC`,req.user.role==='GVMC_EE'?[req.user.zone_id]:[]),
      db.manyOrNone(`SELECT * FROM v_contractor_kpis ${req.user.role==='CONTRACTOR'?'WHERE contractor_id=$1':req.user.role==='GVMC_EE'?'WHERE zone_name IN (SELECT zone_name FROM zones WHERE zone_id=$1)':''} ORDER BY sla_violations_mtd DESC`,req.user.role==='CONTRACTOR'?[req.user.contractor_id]:req.user.role==='GVMC_EE'?[req.user.zone_id]:[]),
      db.manyOrNone(`SELECT wo.fault_category,COUNT(*)::int count FROM work_orders wo JOIN poles p ON p.pole_id=wo.pole_id ${req.user.role==='GVMC_EE'?'WHERE EXISTS (SELECT 1 FROM junction_boxes jb JOIN wards w ON w.ward_id=jb.ward_id WHERE jb.cabinet_id=p.cabinet_id AND w.zone_id=$1)':''} GROUP BY wo.fault_category ORDER BY count DESC`,req.user.role==='GVMC_EE'?[req.user.zone_id]:[])
    ]);
    res.json({ok:true,generated_at:new Date().toISOString(),zones,contractors,faults});
  }catch(err){logger.error('Overview report error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

module.exports=router;
