'use strict';

const express = require('express');
const db = require('../../config/database');
const logger = require('../utils/logger');
const { requireAuth, requireRole, auditLog } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('SUPER_ADMIN', 'GVMC_COMMISSIONER', 'GVMC_EE', 'CONTRACTOR', 'READ_ONLY'));

function assertScopedIdentity(user, res) {
  if (user.role === 'CONTRACTOR' && !user.contractor_id) {
    res.status(403).json({ ok: false, error: 'Access denied: user has no assigned contractor' });
    return false;
  }
  if (user.role === 'GVMC_EE' && !user.zone_id) {
    res.status(403).json({ ok: false, error: 'Access denied: user has no assigned zone' });
    return false;
  }
  return true;
}

function scope(user, params, conditions, alias = 'c') {
  if (user.role === 'CONTRACTOR') {
    params.push(user.contractor_id);
    conditions.push(`${alias}.contractor_id = $${params.length}`);
  } else if (user.role === 'GVMC_EE') {
    params.push(user.zone_id);
    conditions.push(`${alias}.assigned_zone_id = $${params.length}`);
  }
}

router.get('/', async (req, res) => {
  if (!assertScopedIdentity(req.user, res)) return;
  try {
    const params = [], conditions = [];
    scope(req.user, params, conditions);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await db.manyOrNone(`
      SELECT *,
        ROUND(COALESCE(100.0 * resolved_90d / NULLIF(orders_90d,0),0),2) resolution_rate_90d_pct,
        ROUND(COALESCE(100.0 * sla_violations_90d / NULLIF(orders_90d,0),0),2) sla_violation_rate_90d_pct,
        ROUND(COALESCE(100.0 * repeat_failure_orders_90d / NULLIF(orders_90d,0),0),2) repeat_failure_rate_90d_pct,
        ROUND(COALESCE(100.0 * evidence_backed_resolutions / NULLIF(resolved_90d,0),0),2) evidence_coverage_pct
      FROM v_contractor_accountability
      ${where}
      ORDER BY sla_violations_90d DESC, repeat_failure_orders_90d DESC, company_name`, params);
    res.json({ ok:true, generated_at:new Date().toISOString(), window_days:90, data:rows });
  } catch (err) {
    logger.error('Contractor accountability error', {error:err.message});
    res.status(500).json({ok:false,error:'Internal server error'});
  }
});

router.get('/:id', async (req,res) => {
  if (!assertScopedIdentity(req.user, res)) return;
  const id=Number.parseInt(req.params.id,10);
  if(!Number.isInteger(id)) return res.status(400).json({ok:false,error:'Invalid contractor id'});
  try {
    const params=[id], conditions=[];
    if(req.user.role==='CONTRACTOR') { if(id!==req.user.contractor_id)return res.status(403).json({ok:false,error:'Access denied'}); }
    if(req.user.role==='GVMC_EE') { params.push(req.user.zone_id); conditions.push(`c.assigned_zone_id=$${params.length}`); }
    const contractor=await db.oneOrNone(`SELECT c.contractor_id,c.company_name,c.assigned_zone_id,z.zone_name,c.target_glow_rate,c.active_crews_deployed,c.monthly_invoice_base,c.total_penalty_mtd FROM contractors c LEFT JOIN zones z ON z.zone_id=c.assigned_zone_id WHERE c.contractor_id=$1 ${conditions.length?'AND '+conditions.join(' AND '):''}` ,params);
    if(!contractor)return res.status(404).json({ok:false,error:'Contractor not found'});
    const [performance,contracts,repeatFailures,evidence,penalties]=await Promise.all([
      db.manyOrNone(`SELECT * FROM contractor_performance_snapshots WHERE contractor_id=$1 ORDER BY as_of_date DESC LIMIT 24`,[id]),
      db.manyOrNone(`SELECT contract_id,contract_number,title,start_date,end_date,contract_value_inr,warranty_days,status FROM municipal_contracts WHERE contractor_id=$1 ORDER BY start_date DESC NULLS LAST`,[id]),
      db.manyOrNone(`SELECT wo.work_order_id,wo.pole_id,p.pole_number,wo.fault_category,wo.reported_timestamp,prior.prior_count FROM work_orders wo JOIN poles p ON p.pole_id=wo.pole_id JOIN LATERAL (SELECT COUNT(*)::int prior_count FROM work_orders w2 WHERE w2.pole_id=wo.pole_id AND w2.contractor_id=wo.contractor_id AND w2.work_order_id<>wo.work_order_id AND w2.reported_timestamp<wo.reported_timestamp AND w2.reported_timestamp>=wo.reported_timestamp-INTERVAL '90 days') prior ON TRUE WHERE wo.contractor_id=$1 AND wo.reported_timestamp>=NOW()-INTERVAL '90 days' AND prior.prior_count>0 ORDER BY wo.reported_timestamp DESC LIMIT 200`,[id]),
      db.manyOrNone(`SELECT wo.work_order_id,wo.pole_id,wo.resolved_timestamp,e.cnt after_evidence,v.result verification_result FROM work_orders wo LEFT JOIN LATERAL (SELECT COUNT(*)::int cnt FROM work_order_evidence e0 WHERE e0.work_order_id=wo.work_order_id AND e0.evidence_type='AFTER') e ON TRUE LEFT JOIN LATERAL (SELECT v0.result FROM work_order_verifications v0 WHERE v0.work_order_id=wo.work_order_id ORDER BY v0.verified_at DESC LIMIT 1) v ON TRUE WHERE wo.contractor_id=$1 AND wo.ticket_status='RESOLVED' ORDER BY wo.resolved_timestamp DESC LIMIT 200`,[id]),
      db.manyOrNone(`SELECT l.penalty_id,l.work_order_id,l.penalty_type,l.amount_inr,l.days_overdue,l.assessed_at,l.calculation_basis FROM contractor_penalty_ledger l WHERE l.contractor_id=$1 ORDER BY l.assessed_at DESC LIMIT 200`,[id])
    ]);
    res.json({ok:true,contractor,performance,contracts,repeat_failures:repeatFailures,evidence_resolutions:evidence,penalties});
  } catch(err) {
    logger.error('Contractor accountability detail error',{error:err.message});
    res.status(500).json({ok:false,error:'Internal server error'});
  }
});

router.get('/:id/scorecard', async(req,res)=>{
  if (!assertScopedIdentity(req.user, res)) return;
  const id=Number.parseInt(req.params.id,10);
  if(!Number.isInteger(id))return res.status(400).json({ok:false,error:'Invalid contractor id'});
  try {
    const params=[id],conditions=[];
    if(req.user.role==='CONTRACTOR'){if(id!==req.user.contractor_id)return res.status(403).json({ok:false,error:'Access denied'});}
    if(req.user.role==='GVMC_EE'){params.push(req.user.zone_id);conditions.push(`assigned_zone_id=$${params.length}`);}
    const row=await db.oneOrNone(`SELECT * FROM v_contractor_accountability WHERE contractor_id=$1 ${conditions.length?'AND '+conditions.join(' AND '):''}` ,params);
    if(!row)return res.status(404).json({ok:false,error:'Contractor not found'});
    const score=Math.max(0,Math.min(100,
      100 - Number(row.sla_violations_90d)*5 - Number(row.repeat_failure_orders_90d)*4 - Number(row.penalized_orders_90d)*3 + Number(row.evidence_backed_resolutions)*1));
    res.json({ok:true,advisory:true,methodology:'Explainable accountability score; not a procurement or payment decision.',score:Math.round(score*100)/100,components:{sla_violations_90d:Number(row.sla_violations_90d),repeat_failure_orders_90d:Number(row.repeat_failure_orders_90d),penalized_orders_90d:Number(row.penalized_orders_90d),evidence_backed_resolutions:Number(row.evidence_backed_resolutions)}});
  } catch(err){logger.error('Contractor scorecard error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

module.exports = router;
