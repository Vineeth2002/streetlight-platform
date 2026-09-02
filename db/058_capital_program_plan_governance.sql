BEGIN;

ALTER TABLE municipal_capital_programs
  ADD COLUMN IF NOT EXISTS plan_title_at_program TEXT,
  ADD COLUMN IF NOT EXISTS plan_status_at_program TEXT,
  ADD COLUMN IF NOT EXISTS plan_policy_alignment_at_program TEXT,
  ADD COLUMN IF NOT EXISTS plan_link_captured_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_capital_programs_plan_status
  ON municipal_capital_programs(plan_id,status);

CREATE OR REPLACE VIEW v_municipal_capital_program_plan_alignment AS
SELECT cp.capital_program_id,cp.program_key,cp.title,cp.zone_id,cp.plan_id,
       cp.status AS capital_program_status,
       p.plan_title,p.status AS current_plan_status,p.investment_theme AS plan_investment_theme,
       p.strategy_policy_id,p.policy_key_at_plan,p.policy_status_at_plan,
       p.policy_evidence_state_at_plan,p.policy_evidence_captured_at,
       pa.policy_alignment_state,
       CASE
         WHEN cp.plan_id IS NULL THEN 'PLAN_NOT_LINKED'
         WHEN p.plan_id IS NULL THEN 'PLAN_NO_LONGER_PRESENT'
         WHEN p.status='REJECTED' THEN 'PLAN_REJECTED'
         WHEN p.status IN ('PROPOSED','UNDER_REVIEW') THEN 'PLAN_NOT_APPROVED'
         WHEN pa.policy_alignment_state<>'POLICY_ALIGNED' THEN 'PLAN_POLICY_REVIEW_REQUIRED'
         WHEN cp.zone_id IS DISTINCT FROM p.zone_id AND cp.zone_id IS NOT NULL AND p.zone_id IS NOT NULL THEN 'PLAN_ZONE_MISMATCH'
         WHEN cp.investment_theme IS DISTINCT FROM p.investment_theme THEN 'PLAN_THEME_MISMATCH'
         ELSE 'PLAN_ALIGNED'
       END AS plan_alignment_state
FROM municipal_capital_programs cp
LEFT JOIN municipal_capital_plans p ON p.plan_id=cp.plan_id
LEFT JOIN v_municipal_capital_policy_alignment pa ON pa.plan_id=p.plan_id;

COMMIT;
