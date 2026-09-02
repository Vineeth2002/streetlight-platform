BEGIN;

-- Advisory learning derived from human-attributed scenario-to-program outcomes.
-- Learning is evidence synthesis only: it does not select scenarios, allocate funding,
-- create programs, or establish causal proof.
CREATE OR REPLACE VIEW v_municipal_capital_scenario_program_learning AS
WITH evidence AS (
  SELECT
    a.attribution_id,
    a.capital_program_id,
    a.attribution_state,
    v.scenario_key,
    v.zone_id,
    v.zone_name,
    v.outcome_band,
    v.expected_benefit_score,
    v.observed_benefit_score,
    v.health_delta,
    v.reliability_delta,
    v.work_order_delta,
    v.sla_exposure_delta,
    v.penalty_delta_inr
  FROM municipal_capital_scenario_program_outcome_attributions a
  JOIN v_municipal_capital_scenario_program_outcome_attribution v
    ON v.attribution_id=a.attribution_id
  WHERE a.attribution_state IN ('ATTRIBUTED','INSUFFICIENT_EVIDENCE')
), grouped AS (
  SELECT
    zone_id,
    zone_name,
    scenario_key,
    COUNT(DISTINCT capital_program_id)::int AS programs_observed,
    COUNT(*)::int AS attribution_records,
    COUNT(*) FILTER (WHERE attribution_state='ATTRIBUTED')::int AS attributed_outcomes,
    COUNT(*) FILTER (WHERE attribution_state='INSUFFICIENT_EVIDENCE')::int AS evidence_gaps,
    COUNT(*) FILTER (WHERE attribution_state='ATTRIBUTED' AND outcome_band='DELIVERED')::int AS delivered_outcomes,
    COUNT(*) FILTER (WHERE attribution_state='ATTRIBUTED' AND outcome_band='PARTIAL')::int AS partial_outcomes,
    COUNT(*) FILTER (WHERE attribution_state='ATTRIBUTED' AND outcome_band='NO_MEASURABLE_BENEFIT')::int AS unsuccessful_outcomes,
    ROUND(AVG(observed_benefit_score) FILTER (WHERE attribution_state='ATTRIBUTED'),2) AS avg_observed_benefit_score,
    ROUND(AVG(expected_benefit_score) FILTER (WHERE attribution_state='ATTRIBUTED'),2) AS avg_expected_benefit_score,
    ROUND(AVG(health_delta) FILTER (WHERE attribution_state='ATTRIBUTED'),2) AS avg_health_delta,
    ROUND(AVG(reliability_delta) FILTER (WHERE attribution_state='ATTRIBUTED'),2) AS avg_reliability_delta,
    ROUND(AVG(work_order_delta) FILTER (WHERE attribution_state='ATTRIBUTED'),2) AS avg_work_order_delta,
    ROUND(AVG(sla_exposure_delta) FILTER (WHERE attribution_state='ATTRIBUTED'),2) AS avg_sla_exposure_delta,
    ROUND(AVG(penalty_delta_inr) FILTER (WHERE attribution_state='ATTRIBUTED'),2) AS avg_penalty_delta_inr
  FROM evidence
  GROUP BY zone_id,zone_name,scenario_key
)
SELECT
  g.*,
  CASE
    WHEN g.attributed_outcomes < 2 THEN 'INSUFFICIENT_EVIDENCE'
    WHEN (100.0*g.delivered_outcomes/NULLIF(g.attributed_outcomes,0)) >= 70
         AND COALESCE(g.avg_observed_benefit_score,0) >= 70 THEN 'POSITIVE_PATTERN'
    WHEN (100.0*g.unsuccessful_outcomes/NULLIF(g.attributed_outcomes,0)) >= 40
         OR COALESCE(g.avg_observed_benefit_score,0) < 30 THEN 'NEGATIVE_PATTERN'
    ELSE 'MIXED_PATTERN'
  END AS learning_signal,
  CASE
    WHEN g.attributed_outcomes < 2 THEN 'BUILD_MORE_OUTCOME_EVIDENCE'
    WHEN (100.0*g.delivered_outcomes/NULLIF(g.attributed_outcomes,0)) >= 70
         AND COALESCE(g.avg_observed_benefit_score,0) >= 70 THEN 'CONSIDER_REUSE_WITH_CONTEXT_REVIEW'
    WHEN (100.0*g.unsuccessful_outcomes/NULLIF(g.attributed_outcomes,0)) >= 40
         OR COALESCE(g.avg_observed_benefit_score,0) < 30 THEN 'REVIEW_SCENARIO_PROGRAM_ASSUMPTIONS'
    ELSE 'COMPARE_CONTEXT_BEFORE_REUSE'
  END AS learning_guidance,
  'HUMAN_GOVERNED_SCENARIO_PROGRAM_LEARNING' AS learning_authority,
  'NO_AUTOMATIC_SCENARIO_SELECTION_OR_FUNDING_ACTION' AS governance_constraint
FROM grouped g;

CREATE OR REPLACE VIEW v_municipal_capital_scenario_program_learning_summary AS
SELECT
  zone_id,
  zone_name,
  scenario_key,
  COUNT(*)::int AS learning_patterns,
  SUM(programs_observed)::int AS programs_observed,
  SUM(attributed_outcomes)::int AS attributed_outcomes,
  SUM(evidence_gaps)::int AS evidence_gaps,
  ROUND(AVG(avg_observed_benefit_score),2) AS avg_observed_benefit_score,
  COUNT(*) FILTER (WHERE learning_signal='POSITIVE_PATTERN')::int AS positive_patterns,
  COUNT(*) FILTER (WHERE learning_signal='MIXED_PATTERN')::int AS mixed_patterns,
  COUNT(*) FILTER (WHERE learning_signal='NEGATIVE_PATTERN')::int AS negative_patterns,
  COUNT(*) FILTER (WHERE learning_signal='INSUFFICIENT_EVIDENCE')::int AS insufficient_evidence_patterns
FROM v_municipal_capital_scenario_program_learning
GROUP BY zone_id,zone_name,scenario_key;

COMMIT;
