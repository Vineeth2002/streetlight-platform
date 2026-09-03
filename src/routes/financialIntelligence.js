'use strict';
const express=require('express');
const db=require('../../config/database');
const logger=require('../utils/logger');
const { requireAuth, requireRole } = require('../middleware/auth');

const router=express.Router();
router.use(requireAuth);
router.use(requireRole('SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','CONTRACTOR','READ_ONLY'));

function assertScopedIdentity(user,res) {
  if (user.role === 'GVMC_EE' && !user.zone_id) {
    res.status(403).json({ok:false,error:'Access denied: user has no assigned zone'});
    return false;
  }
  if (user.role === 'CONTRACTOR' && !user.contractor_id) {
    res.status(403).json({ok:false,error:'Access denied: user has no assigned contractor'});
    return false;
  }
  return true;
}

function scope(user, params, conditions) {
  if (user.role === 'CONTRACTOR') {
    params.push(user.contractor_id);
    conditions.push(`contractor_id=$${params.length}`);
  } else if (user.role === 'GVMC_EE') {
    params.push(user.zone_id);
    conditions.push(`assigned_zone_id=$${params.length}`);
  }
}

router.get('/', async (req,res) => {
  if (!assertScopedIdentity(req.user,res)) return;
  try {
    const params=[],conditions=[];
    scope(req.user,params,conditions);
    const where=conditions.length?`WHERE ${conditions.join(' AND ')}`:'';
    const data=await db.manyOrNone(`SELECT * FROM v_contract_financial_intelligence ${where} ORDER BY penalty_mtd_inr DESC,contract_value_inr DESC NULLS LAST LIMIT 500`,params);
    const totals=await db.one(`SELECT COUNT(*)::int contracts,COALESCE(SUM(contract_value_inr),0) contract_value_inr,COALESCE(SUM(monthly_invoice_base_inr),0) monthly_invoice_base_inr,COALESCE(SUM(penalty_mtd_inr),0) penalty_mtd_inr,COALESCE(SUM(penalties_ledger_inr),0) penalties_ledger_inr,COALESCE(SUM(net_payable_basis_inr),0) net_payable_basis_inr FROM v_contract_financial_intelligence ${where}`,params);
    res.json({ok:true,generated_at:new Date().toISOString(),advisory:true,totals,data});
  } catch(err) { logger.error('Financial intelligence error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'}); }
});

router.get('/contract/:id', async (req,res) => {
  if (!assertScopedIdentity(req.user,res)) return;
  const id=Number.parseInt(req.params.id,10);
  if(!Number.isInteger(id))return res.status(400).json({ok:false,error:'Invalid contract id'});
  try {
    const row=await db.oneOrNone(`SELECT * FROM v_contract_financial_intelligence WHERE contract_id=$1`,[id]);
    if(!row)return res.status(404).json({ok:false,error:'Contract not found'});
    if(req.user.role==='CONTRACTOR'&&row.contractor_id!==req.user.contractor_id)return res.status(403).json({ok:false,error:'Access denied'});
    if(req.user.role==='GVMC_EE'&&row.assigned_zone_id!==req.user.zone_id)return res.status(403).json({ok:false,error:'Access denied'});
    const [procurement,penalties]=await Promise.all([
      db.manyOrNone(`SELECT procurement_id,tender_number,procurement_method,notice_date,award_date,estimated_value_inr,awarded_value_inr,status FROM procurement_records WHERE contract_id=$1 ORDER BY COALESCE(award_date,notice_date) DESC NULLS LAST`,[id]),
      db.manyOrNone(`SELECT l.penalty_id,l.work_order_id,l.penalty_type,l.amount_inr,l.days_overdue,l.assessed_at,l.calculation_basis FROM contractor_penalty_ledger l JOIN work_orders wo ON wo.work_order_id=l.work_order_id JOIN municipal_contracts c ON c.contractor_id=l.contractor_id WHERE c.contract_id=$1 AND (c.start_date IS NULL OR l.assessed_at>=c.start_date) AND (c.end_date IS NULL OR l.assessed_at<c.end_date+INTERVAL '1 day') ORDER BY l.assessed_at DESC LIMIT 500`,[id])
    ]);
    res.json({ok:true,advisory:true,contract:row,procurement,penalties});
  } catch(err) { logger.error('Financial contract detail error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'}); }
});

module.exports=router;
