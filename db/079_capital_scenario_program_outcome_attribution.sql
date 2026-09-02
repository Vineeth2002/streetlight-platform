BEGIN;

-- Human-governed attribution of observed capital-program outcomes to a
-- scenario-to-program linkage. This records evidence and does not establish
-- causal proof or mutate operational state.
CREATE TABLE IF NOT EXISTS municipal_capital_scenario_program_outcome_attributions (
  attribution_id BIGSERIAL PRIMARY KEY,
  link_id BIGINT NOT NULL REFERENCES municipal_capital_scenario_program_links(link_id) ON DELETE RESTRICT,
  capital_program_id BIGINT NOT NULL REFERENCES municipal_capital_programs(capital_program_id) ON DELETE RESTRICT,
  outcome_assessment_id BIGINT NOT NULL REFERENCES municipal_capital_program_outcome_assessments(assessment_id) ON DELETE RESTRICT,
  attribution_state TEXT NOT NULL CHECK (attribution_state IN ('PENDING','EVIDENCE_AVAILABLE','ATTRIBUTED','INSUFFICIENT_EVIDENCE','NOT_ATTRIBUTABLE')),
  baseline_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  outcome_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  attribution_rationale TEXT,
  evidence_captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assessed_by INT REFERENCES users(user_id) ON DELETE SET NULL,
  assessed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(link_id,outcome_assessment_id)
);

CREATE INDEX IF NOT EXISTS idx_capital_scenario_program_outcome_attr_link
  ON municipal_capital_scenario_program_outcome_attributions(link_id);
CREATE INDEX IF NOT EXISTS idx_capital_scenario_program_outcome_attr_program
  ON municipal_capital_scenario_program_outcome_attributions(capital_program_id);
CREATE INDEX IF NOT EXISTS idx_capital_scenario_program_outcome_attr_assessment
  ON municipal_capital_scenario_program_outcome_attributions(outcome_assessment_id);

CREATE OR REPLACE FUNCTION prevent_capital_scenario_program_outcome_attribution_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Capital scenario-program outcome attribution records are append-only' USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_capital_scenario_program_outcome_attr_append_only
  ON municipal_capital_scenario_program_outcome_attributions;
CREATE TRIGGER trg_capital_scenario_program_outcome_attr_append_only
BEFORE UPDATE OR DELETE ON municipal_capital_scenario_program_outcome_attributions
FOR EACH ROW EXECUTE FUNCTION prevent_capital_scenario_program_outcome_attribution_mutation();

CREATE OR REPLACE VIEW v_municipal_capital_scenario_program_outcome_attribution AS
SELECT
  a.attribution_id,
  a.link_id,
  a.capital_program_id,
  a.outcome_assessment_id,
  l.scenario_key,
  l.zone_id,
  z.zone_name,
  l.decision_id,
  l.guidance_state,
  l.revalidation_state,
  l.selection_rationale,
  cp.program_key,
  cp.title AS program_title,
  cp.status AS program_status,
  o.observation_window_days,
  o.measured_at,
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
    WHEN a.attribution_state='ATTRIBUTED' THEN 'SCENARIO_PROGRAM_OUTCOME_ATTRIBUTED'
    WHEN a.attribution_state='INSUFFICIENT_EVIDENCE' THEN 'EVIDENCE_GAP'
    WHEN a.attribution_state='NOT_ATTRIBUTABLE' THEN 'NOT_ATTRIBUTABLE'
    ELSE 'ATTRIBUTION_REVIEW_REQUIRED'
  END AS attribution_context,
  'HUMAN_EVIDENCE_ATTRIBUTION_NO_CAUSAL_PROOF' AS attribution_authority,
  'SCENARIO_INFORMED_PROGRAM_LINKAGE_DOES_NOT_ESTABLISH_CAUSALITY' AS causal_constraint
FROM municipal_capital_scenario_program_outcome_attributions a
JOIN municipal_capital_scenario_program_links l ON l.link_id=a.link_id
JOIN municipal_capital_programs cp ON cp.capital_program_id=a.capital_program_id
JOIN v_municipal_capital_program_outcomes o ON o.assessment_id=a.outcome_assessment_id
LEFT JOIN zones z ON z.zone_id=l.zone_id
WHERE o.capital_program_id=a.capital_program_id;

CREATE OR REPLACE VIEW v_municipal_capital_scenario_program_outcome_attribution_summary AS
SELECT
  zone_id,
  zone_name,
  scenario_key,
  COUNT(*)::int AS attribution_records,
  COUNT(*) FILTER (WHERE attribution_state='ATTRIBUTED')::int AS attributed_records,
  COUNT(*) FILTER (WHERE attribution_state='EVIDENCE_AVAILABLE')::int AS evidence_available_records,
  COUNT(*) FILTER (WHERE attribution_state='INSUFFICIENT_EVIDENCE')::int AS evidence_gaps,
  COUNT(*) FILTER (WHERE attribution_state='NOT_ATTRIBUTABLE')::int AS not_attributable_records,
  ROUND(AVG(observed_benefit_score) FILTER (WHERE attribution_state='ATTRIBUTED'),2) AS avg_attributed_benefit_score,
  ROUND(AVG(health_delta) FILTER (WHERE attribution_state='ATTRIBUTED'),2) AS avg_attributed_health_delta,
  ROUND(AVG(reliability_delta) FILTER (WHERE attribution_state='ATTRIBUTED'),2) AS avg_attributed_reliability_delta
FROM v_municipal_capital_scenario_program_outcome_attribution
GROUP BY zone_id,zone_name,scenario_key;

COMMIT;
