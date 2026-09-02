BEGIN;

ALTER TABLE municipal_capital_plans
  ADD COLUMN IF NOT EXISTS strategy_policy_id BIGINT REFERENCES municipal_strategy_policies(policy_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS policy_key_at_plan TEXT,
  ADD COLUMN IF NOT EXISTS policy_status_at_plan TEXT,
  ADD COLUMN IF NOT EXISTS policy_priority_at_plan NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS policy_evidence_state_at_plan TEXT,
  ADD COLUMN IF NOT EXISTS policy_evidence_captured_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_capital_plans_strategy_policy
  ON municipal_capital_plans(strategy_policy_id,status);

CREATE OR REPLACE VIEW v_municipal_capital_policy_alignment AS
SELECT p.plan_id,p.plan_year,p.zone_id,p.plan_title,p.investment_theme,p.proposed_amount_inr,
       p.priority_score,p.status,p.strategy_policy_id,p.policy_key_at_plan,p.policy_status_at_plan,
       p.policy_priority_at_plan,p.policy_evidence_state_at_plan,p.policy_evidence_captured_at,
       sp.policy_key,sp.title AS policy_title,sp.status AS current_policy_status,
       sp.priority_score AS current_policy_priority,sp.source_zone_id,
       pe.evidence_state AS current_policy_evidence_state,
       CASE
         WHEN p.strategy_policy_id IS NULL THEN 'POLICY_NOT_LINKED'
         WHEN sp.policy_id IS NULL THEN 'POLICY_NO_LONGER_PRESENT'
         WHEN sp.status='RETIRED' THEN 'POLICY_RETIRED'
         WHEN pe.evidence_state='EVIDENCE_CHANGED_REVIEW_REQUIRED' THEN 'POLICY_EVIDENCE_CHANGED'
         WHEN pe.evidence_state='SOURCE_EVIDENCE_NO_LONGER_PRESENT' THEN 'POLICY_EVIDENCE_MISSING'
         WHEN sp.status<>'ADOPTED' THEN 'POLICY_NOT_ADOPTED'
         WHEN pe.evidence_state<>'EVIDENCE_CURRENT' THEN 'POLICY_EVIDENCE_NOT_CURRENT'
         ELSE 'POLICY_ALIGNED'
       END AS policy_alignment_state
FROM municipal_capital_plans p
LEFT JOIN municipal_strategy_policies sp ON sp.policy_id=p.strategy_policy_id
LEFT JOIN v_municipal_policy_evidence pe ON pe.policy_id=sp.policy_id;

CREATE OR REPLACE VIEW v_municipal_capital_command AS
SELECT c.*,
       COALESCE(a.policy_aligned_plans,0) AS policy_aligned_plans,
       COALESCE(a.policy_review_plans,0) AS policy_review_plans
FROM (
  SELECT c.zone_id,c.zone_name,c.capital_pressure_score,c.high_replacement_assets,c.replacement_candidates,c.forecast_high_exposure_assets,
         c.allocation_priority_score,c.priority_programs,c.uncommitted_budget_inr,c.expenditure_exposure_inr,
         CASE WHEN c.capital_pressure_score >= 75 THEN 'CRITICAL_REVIEW' WHEN c.capital_pressure_score >= 50 THEN 'HIGH_REVIEW' WHEN c.capital_pressure_score >= 25 THEN 'PLANNING_REVIEW' ELSE 'ROUTINE_REVIEW' END AS capital_review_band,
         CASE WHEN c.high_replacement_assets > 0 AND c.uncommitted_budget_inr <= c.expenditure_exposure_inr THEN 'CAPITAL_RENEWAL_PRESSURE'
              WHEN c.high_replacement_assets > 0 THEN 'REPLACEMENT_PIPELINE'
              WHEN c.priority_programs > 0 THEN 'PROGRAM_INVESTMENT_PRESSURE'
              ELSE 'MONITOR' END AS dominant_capital_signal
  FROM v_municipal_capital_investment_pipeline c
) c
LEFT JOIN (
  SELECT zone_id,
         COUNT(*) FILTER (WHERE policy_alignment_state='POLICY_ALIGNED') AS policy_aligned_plans,
         COUNT(*) FILTER (WHERE policy_alignment_state<>'POLICY_ALIGNED') AS policy_review_plans
  FROM v_municipal_capital_policy_alignment
  GROUP BY zone_id
) a ON a.zone_id IS NOT DISTINCT FROM c.zone_id;

COMMIT;
