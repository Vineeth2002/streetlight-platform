const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const READ_ROLES = ['SUPER_ADMIN', 'GVMC_COMMISSIONER', 'GVMC_EE', 'READ_ONLY'];
router.use(requireAuth, requireRole(READ_ROLES));

function buildScope(req, values) {
  if (req.user.role !== 'GVMC_EE') return '';
  values.push(req.user.zone_id);
  return ` AND zone_id=$${values.length}`;
}

router.get('/memory', async (req, res) => {
  try {
    const values = [], clauses = [];
    if (req.query.scenario_key) { values.push(req.query.scenario_key); clauses.push(`selected_scenario_key=$${values.length}`); }
    if (req.query.memory_state) { values.push(req.query.memory_state); clauses.push(`memory_state=$${values.length}`); }
    const scope = buildScope(req, values);
    const where = [...clauses, scope.replace(/^ AND /, '')].filter(Boolean);
    const result = await pool.query(`SELECT * FROM v_municipal_capital_decision_institutional_memory${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY decided_at DESC NULLS LAST, decision_id DESC LIMIT 200`, values);
    res.json({ data: result.rows, count: result.rowCount });
  } catch (err) { res.status(500).json({ error: 'Failed to retrieve decision memory' }); }
});

router.get('/precedents', async (req, res) => {
  try {
    const values = [], clauses = [`memory_state='VALIDATED_DECISION_HISTORY'`];
    if (req.query.scenario_key) { values.push(req.query.scenario_key); clauses.push(`selected_scenario_key=$${values.length}`); }
    if (req.query.zone_id && req.user.role !== 'GVMC_EE') { values.push(req.query.zone_id); clauses.push(`zone_id=$${values.length}`); }
    const scope = buildScope(req, values);
    clauses.push(scope.replace(/^ AND /, ''));
    const result = await pool.query(`SELECT * FROM v_municipal_capital_decision_institutional_memory WHERE ${clauses.filter(Boolean).join(' AND ')} ORDER BY observed_benefit_score DESC NULLS LAST, decided_at DESC NULLS LAST LIMIT 100`, values);
    res.json({ data: result.rows, count: result.rowCount, advisory: true });
  } catch (err) { res.status(500).json({ error: 'Failed to retrieve decision precedents' }); }
});

router.get('/learning', async (req, res) => {
  try {
    const values = [], clauses = [];
    if (req.query.scenario_key) { values.push(req.query.scenario_key); clauses.push(`selected_scenario_key=$${values.length}`); }
    const scope = buildScope(req, values);
    clauses.push(scope.replace(/^ AND /, ''));
    const result = await pool.query(`SELECT * FROM v_municipal_capital_decision_learning${clauses.filter(Boolean).length ? ` WHERE ${clauses.filter(Boolean).join(' AND ')}` : ''} ORDER BY attributed_outcomes DESC, avg_observed_benefit_score DESC NULLS LAST`, values);
    res.json({ data: result.rows, count: result.rowCount, advisory: true });
  } catch (err) { res.status(500).json({ error: 'Failed to retrieve decision learning' }); }
});

router.get('/revalidated', async (req, res) => {
  try {
    const values = [], clauses = [];
    if (req.query.scenario_key) { values.push(req.query.scenario_key); clauses.push(`selected_scenario_key=$${values.length}`); }
    if (req.query.revalidation_state) { values.push(req.query.revalidation_state); clauses.push(`revalidation_state=$${values.length}`); }
    if (req.query.zone_id && req.user.role !== 'GVMC_EE') { values.push(req.query.zone_id); clauses.push(`zone_id=$${values.length}`); }
    const scope = buildScope(req, values);
    if (scope) clauses.push(scope.replace(/^ AND /, ''));
    const where = clauses.filter(Boolean);
    const result = await pool.query(`SELECT * FROM v_municipal_capital_decision_knowledge_revalidation${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY latest_review_resolved_at DESC NULLS LAST, decision_id DESC LIMIT 200`, values);
    res.json({ data: result.rows, count: result.rowCount, advisory: true, human_review_required: true });
  } catch (err) { res.status(500).json({ error: 'Failed to retrieve revalidated decision knowledge' }); }
});

router.get('/revalidation-summary', async (req, res) => {
  try {
    const values = [], clauses = [];
    if (req.query.scenario_key) { values.push(req.query.scenario_key); clauses.push(`selected_scenario_key=$${values.length}`); }
    if (req.query.zone_id && req.user.role !== 'GVMC_EE') { values.push(req.query.zone_id); clauses.push(`zone_id=$${values.length}`); }
    const scope = buildScope(req, values);
    if (scope) clauses.push(scope.replace(/^ AND /, ''));
    const where = clauses.filter(Boolean);
    const result = await pool.query(`SELECT * FROM v_municipal_capital_decision_knowledge_revalidation_summary${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY decisions DESC`, values);
    res.json({ data: result.rows, count: result.rowCount, advisory: true, human_review_required: true });
  } catch (err) { res.status(500).json({ error: 'Failed to retrieve knowledge revalidation summary' }); }
});

router.get('/scenario-guidance', async (req, res) => {
  try {
    const values = [], clauses = [];
    if (req.query.scenario_key) { values.push(req.query.scenario_key); clauses.push(`scenario_key=$${values.length}`); }
    if (req.query.guidance_state) { values.push(req.query.guidance_state); clauses.push(`guidance_state=$${values.length}`); }
    if (req.query.zone_id && req.user.role !== 'GVMC_EE') { values.push(req.query.zone_id); clauses.push(`zone_id=$${values.length}`); }
    const scope = buildScope(req, values);
    if (scope) clauses.push(scope.replace(/^ AND /, ''));
    const where = clauses.filter(Boolean);
    const result = await pool.query(`SELECT * FROM v_municipal_capital_decision_revalidated_scenario_guidance${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY allocation_priority_score DESC NULLS LAST, scenario_key`, values);
    res.json({ data: result.rows, count: result.rowCount, advisory: true, human_review_required: true, governance_constraint: 'NO_AUTOMATIC_SCENARIO_SELECTION' });
  } catch (err) { res.status(500).json({ error: 'Failed to retrieve revalidated scenario guidance' }); }
});

router.get('/scenario-guidance-summary', async (req, res) => {
  try {
    const values = [], clauses = [];
    if (req.query.scenario_key) { values.push(req.query.scenario_key); clauses.push(`scenario_key=$${values.length}`); }
    if (req.query.guidance_state) { values.push(req.query.guidance_state); clauses.push(`guidance_state=$${values.length}`); }
    if (req.query.zone_id && req.user.role !== 'GVMC_EE') { values.push(req.query.zone_id); clauses.push(`zone_id=$${values.length}`); }
    const scope = buildScope(req, values);
    if (scope) clauses.push(scope.replace(/^ AND /, ''));
    const where = clauses.filter(Boolean);
    const result = await pool.query(`SELECT * FROM v_municipal_capital_decision_revalidated_scenario_summary${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY revalidated_decisions DESC NULLS LAST, scenario_key`, values);
    res.json({ data: result.rows, count: result.rowCount, advisory: true, human_review_required: true, governance_constraint: 'NO_AUTOMATIC_SCENARIO_SELECTION' });
  } catch (err) { res.status(500).json({ error: 'Failed to retrieve scenario guidance summary' }); }
});

module.exports = router;
