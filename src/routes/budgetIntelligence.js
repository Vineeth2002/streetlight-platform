'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);
router.use(requireRole('SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','CONTRACTOR','READ_ONLY'));

async function scopedBudgetWhere(user, alias='b') {
  if (user.role === 'GVMC_EE') {
    return { clause: ` AND ${alias}.zone_id = $1`, params: [user.zone_id] };
  }
  if (user.role === 'CONTRACTOR') {
    return {
      clause: ` AND EXISTS (
        SELECT 1 FROM budget_contract_commitments bcc_s
        JOIN municipal_contracts mc_s ON mc_s.contract_id=bcc_s.contract_id
        WHERE bcc_s.budget_id=${alias}.budget_id AND mc_s.contractor_id=$1
      )`,
      params: [user.contractor_id]
    };
  }
  return { clause: '', params: [] };
}

router.get('/', async (req, res, next) => {
  try {
    const scope = await scopedBudgetWhere(req.user);
    const rows = await db.any(`
      SELECT *
      FROM v_budget_expenditure_intelligence b
      WHERE TRUE ${scope.clause}
      ORDER BY b.budget_year DESC, b.budget_id DESC
      LIMIT 500
    `, scope.params);

    const totals = rows.reduce((a, r) => {
      a.effective_budget_inr += Number(r.effective_budget_inr || 0);
      a.committed_amount_inr += Number(r.committed_amount_inr || 0);
      a.invoice_basis_inr += Number(r.invoice_basis_inr || 0);
      a.penalties_inr += Number(r.penalties_inr || 0);
      a.net_payable_basis_inr += Number(r.net_payable_basis_inr || 0);
      return a;
    }, { effective_budget_inr: 0, committed_amount_inr: 0, invoice_basis_inr: 0, penalties_inr: 0, net_payable_basis_inr: 0 });

    res.json({ ok: true, budgets: rows, totals });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const budgetId = Number(req.params.id);
    if (!Number.isInteger(budgetId) || budgetId <= 0) return res.status(400).json({ ok:false, error:'Invalid budget id' });

    const scope = await scopedBudgetWhere(req.user);
    const budget = await db.oneOrNone(`
      SELECT * FROM v_budget_expenditure_intelligence b
      WHERE b.budget_id=$1 ${scope.clause}
    `, [budgetId, ...scope.params]);
    if (!budget) return res.status(404).json({ ok:false, error:'Budget not found' });

    const commitments = await db.any(`
      SELECT bcc.commitment_id, bcc.contract_id, bcc.committed_amount_inr,
             bcc.commitment_date, bcc.status, mc.contract_number, mc.title,
             mc.contractor_id, co.company_name
      FROM budget_contract_commitments bcc
      JOIN municipal_contracts mc ON mc.contract_id=bcc.contract_id
      JOIN contractors co ON co.contractor_id=mc.contractor_id
      WHERE bcc.budget_id=$1
        ${req.user.role === 'CONTRACTOR' ? 'AND mc.contractor_id=$2' : ''}
        ${req.user.role === 'GVMC_EE' ? 'AND EXISTS (SELECT 1 FROM contract_segments cs WHERE cs.contract_id=mc.contract_id AND cs.zone_id=$2)' : ''}
      ORDER BY bcc.committed_amount_inr DESC
    `, req.user.role === 'CONTRACTOR' || req.user.role === 'GVMC_EE' ? [budgetId, req.user.role === 'CONTRACTOR' ? req.user.contractor_id : req.user.zone_id] : [budgetId]);

    const snapshot = await db.any(`
      SELECT * FROM budget_expenditure_snapshots
      WHERE budget_id=$1 ORDER BY as_of_date DESC LIMIT 24
    `, [budgetId]);

    res.json({ ok:true, budget, commitments, snapshots });
  } catch (err) { next(err); }
});

module.exports = router;
