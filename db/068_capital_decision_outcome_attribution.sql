BEGIN;

-- Human-governed attribution of observed program outcomes to an endorsed capital decision.
-- This records evidence; it does not establish causal proof or change operational state.
CREATE TABLE IF NOT EXISTS municipal_capital_decision_outcome_attributions (
  attribution_id BIGSERIAL PRIMARY KEY,
  decision_id BIGINT NOT NULL REFERENCES municipal_capital_portfolio_decisions(decision_id) ON DELETE RESTRICT,
  decision_link_id BIGINT NOT NULL REFERENCES municipal_capital_decision_links(decision_link_id) ON DELETE RESTRICT,
  outcome_assessment_id BIGINT NOT NULL REFERENCES municipal_capital_program_outcome_assessments(assessment_id) ON DELETE RESTRICT,
  attribution_state TEXT NOT NULL CHECK (attribution_state IN ('PENDING','EVIDENCE_AVAILABLE','ATTRIBUTED','INSUFFICIENT_EVIDENCE','NOT_ATTRIBUTABLE')),
  baseline_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  outcome_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  attribution_rationale TEXT,
  evidence_captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assessed_by INT REFERENCES users(user_id) ON DELETE SET NULL,
  assessed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(decision_link_id,outcome_assessment_id)
);

CREATE INDEX IF NOT EXISTS idx_capital_decision_outcome_attr_decision ON municipal_capital_decision_outcome_attributions(decision_id);
CREATE INDEX IF NOT EXISTS idx_capital_decision_outcome_attr_link ON municipal_capital_decision_outcome_attributions(decision_link_id);
CREATE INDEX IF NOT EXISTS idx_capital_decision_outcome_attr_assessment ON municipal_capital_decision_outcome_attributions(outcome_assessment_id);

CREATE OR REPLACE FUNCTION prevent_capital_decision_outcome_attribution_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Capital decision outcome attribution records are append-only' USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_capital_decision_outcome_attr_append_only ON municipal_capital_decision_outcome_attributions;
CREATE TRIGGER trg_capital_decision_outcome_attr_append_only
BEFORE UPDATE OR DELETE ON municipal_capital_decision_outcome_attributions
FOR EACH ROW EXECUTE FUNCTION prevent_capital_decision_outcome_attribution_mutation();

CREATE OR REPLACE VIEW v_municipal_capital_decision_outcome_attribution AS
SELECT
  a.attribution_id,
  a.decision_id,
  a.decision_link_id,
  d.zone_id,
  z.zone_name,
  d.selected_scenario_key,
  d.decision_state,
  l.linkage_type,
  l.capital_plan_id,
  l.capital_program_id,
  o.assessment_id AS outcome_assessment_id,
  o.capital_program_id AS outcome_program_id,
  o.title AS program_title,
  o.status AS program_status,
  o.outcome_band,
  o.expected_benefit_score,
  o.observed_benefit_score,
  o.health_delta,
  o.reliability_delta,
  o.work_order_delta,
  o.sla_exposure_delta,
  o.penalty_delta_inr,
  a.attribution_state,
  a.baseline_snapshot,
  a.outcome_snapshot,
  a.attribution_rationale,
  a.evidence_captured_at,
  a.assessed_by,
  a.assessed_at,
  a.created_at,
  CASE
    WHEN d.decision_state='ENDORSED' AND a.attribution_state='ATTRIBUTED' THEN 'DECISION_OUTCOME_ATTRIBUTED'
    WHEN a.attribution_state='INSUFFICIENT_EVIDENCE' THEN 'EVIDENCE_GAP'
    WHEN d.decision_state='SUPERSEDED' THEN 'SUPERSEDED_DECISION'
    ELSE 'ATTRIBUTION_REVIEW_REQUIRED'
  END AS attribution_context,
  'HUMAN_EVIDENCE_ATTRIBUTION' AS decision_authority
FROM municipal_capital_decision_outcome_attributions a
JOIN municipal_capital_portfolio_decisions d ON d.decision_id=a.decision_id
JOIN municipal_capital_decision_links l ON l.decision_link_id=a.decision_link_id
JOIN v_municipal_capital_program_outcomes o ON o.assessment_id=a.outcome_assessment_id
LEFT JOIN zones z ON z.zone_id=d.zone_id;

CREATE OR REPLACE VIEW v_municipal_capital_decision_outcome_attribution_summary AS
SELECT
  zone_id,
  zone_name,
  COUNT(*)::int AS attribution_records,
  COUNT(*) FILTER (WHERE attribution_state='ATTRIBUTED')::int AS attributed_records,
  COUNT(*) FILTER (WHERE attribution_state='INSUFFICIENT_EVIDENCE')::int AS evidence_gaps,
  COUNT(*) FILTER (WHERE attribution_context='DECISION_OUTCOME_ATTRIBUTED')::int AS endorsed_outcomes,
  COUNT(*) FILTER (WHERE attribution_context='SUPERSEDED_DECISION')::int AS superseded_decisions
FROM v_municipal_capital_decision_outcome_attribution
GROUP BY zone_id,zone_name;

COMMIT;
