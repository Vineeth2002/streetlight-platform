BEGIN;

-- Aggregates governed, human-attributed decision outcomes into reusable learning signals.
-- This is advisory evidence synthesis; it does not adopt policy, alter funding, or change operations.
CREATE OR REPLACE VIEW v_municipal_capital_decision_learning AS
WITH evidence AS (
  SELECT
    a.decision_id,
    d.zone_id,
    d.selected_scenario_key,
    a.attribution_state,
    o.outcome_band,
    o.expected_benefit_score,
    o.observed_benefit_score,
    o.health_delta,
    o.reliability_delta,
    o.work_order_delta,
    o.sla_exposure_delta,
    o.penalty_delta_inr
  FROM municipal_capital_decision_outcome_attributions a
  JOIN municipal_capital_portfolio_decisions d ON d.decision_id=a.decision_id
  JOIN v_municipal_capital_program_outcomes o ON o.assessment_id=a.outcome_assessment_id
  WHERE d.decision_state='ENDORSED'
), grouped AS (
  SELECT
    zone_id,
    selected_scenario_key,
    COUNT(DISTINCT decision_id)::int AS endorsed_decisions,
    COUNT(*) FILTER (WHERE attribution_state='ATTRIBUTED')::int AS attributed_outcomes,
    COUNT(*) FILTER (WHERE attribution_state='INSUFFICIENT_EVIDENCE')::int AS evidence_gaps,
    ROUND(AVG(observed_benefit_score) FILTER (WHERE attribution_state='ATTRIBUTED'),2) AS avg_observed_benefit_score,
    ROUND(AVG(health_delta) FILTER (WHERE attribution_state='ATTRIBUTED'),2) AS avg_health_delta,
    ROUND(AVG(reliability_delta) FILTER (WHERE attribution_state='ATTRIBUTED'),2) AS avg_reliability_delta,
    ROUND(AVG(work_order_delta) FILTER (WHERE attribution_state='ATTRIBUTED'),2) AS avg_work_order_delta,
    ROUND(AVG(sla_exposure_delta) FILTER (WHERE attribution_state='ATTRIBUTED'),2) AS avg_sla_exposure_delta,
    ROUND(AVG(penalty_delta_inr) FILTER (WHERE attribution_state='ATTRIBUTED'),2) AS avg_penalty_delta_inr,
    COUNT(*) FILTER (WHERE attribution_state='ATTRIBUTED' AND outcome_band='DELIVERED')::int AS delivered_outcomes,
    COUNT(*) FILTER (WHERE attribution_state='ATTRIBUTED' AND outcome_band='PARTIAL')::int AS partial_outcomes,
    COUNT(*) FILTER (WHERE attribution_state='ATTRIBUTED' AND outcome_band='NO_MEASURABLE_BENEFIT')::int AS unsuccessful_outcomes
  FROM evidence
  GROUP BY zone_id,selected_scenario_key
)
SELECT
  g.*,
  CASE
    WHEN g.attributed_outcomes < 2 THEN 'INSUFFICIENT_EVIDENCE'
    WHEN (100.0*g.delivered_outcomes/NULLIF(g.attributed_outcomes,0)) >= 70
         AND COALESCE(g.avg_observed_benefit_score,0) >= 70 THEN 'RETAIN'
    WHEN (100.0*g.unsuccessful_outcomes/NULLIF(g.attributed_outcomes,0)) >= 40
         OR COALESCE(g.avg_observed_benefit_score,0) < 30 THEN 'REVISE'
    ELSE 'REVIEW'
  END AS learning_signal,
  CASE
    WHEN g.attributed_outcomes < 2 THEN 'BUILD_MORE_OUTCOME_EVIDENCE'
    WHEN (100.0*g.delivered_outcomes/NULLIF(g.attributed_outcomes,0)) >= 70
         AND COALESCE(g.avg_observed_benefit_score,0) >= 70 THEN 'REUSE_PATTERN_WITH_CONTEXT_REVIEW'
    WHEN (100.0*g.unsuccessful_outcomes/NULLIF(g.attributed_outcomes,0)) >= 40
         OR COALESCE(g.avg_observed_benefit_score,0) < 30 THEN 'REVIEW_DECISION_DESIGN_AND_CONTEXT'
    ELSE 'COMPARE_CONTEXT_BEFORE_REUSE'
  END AS learning_guidance,
  'HUMAN_GOVERNED_DECISION_LEARNING' AS decision_authority
FROM grouped g;

CREATE OR REPLACE VIEW v_municipal_capital_decision_learning_summary AS
SELECT
  zone_id,
  selected_scenario_key,
  COUNT(*)::int AS learning_patterns,
  SUM(endorsed_decisions)::int AS endorsed_decisions,
  SUM(attributed_outcomes)::int AS attributed_outcomes,
  SUM(evidence_gaps)::int AS evidence_gaps,
  ROUND(AVG(avg_observed_benefit_score),2) AS avg_observed_benefit_score,
  COUNT(*) FILTER (WHERE learning_signal='RETAIN')::int AS retain_patterns,
  COUNT(*) FILTER (WHERE learning_signal='REVIEW')::int AS review_patterns,
  COUNT(*) FILTER (WHERE learning_signal='REVISE')::int AS revise_patterns,
  COUNT(*) FILTER (WHERE learning_signal='INSUFFICIENT_EVIDENCE')::int AS insufficient_evidence_patterns
FROM v_municipal_capital_decision_learning
GROUP BY zone_id,selected_scenario_key;

CREATE OR REPLACE VIEW v_municipal_capital_decision_learning_command AS
SELECT
  l.*,
  CASE
    WHEN l.learning_signal='RETAIN' THEN 'POSITIVE_DECISION_PATTERN'
    WHEN l.learning_signal='REVISE' THEN 'DECISION_DESIGN_REVIEW_REQUIRED'
    WHEN l.learning_signal='REVIEW' THEN 'CONTEXTUAL_STRATEGIC_REVIEW'
    ELSE 'EVIDENCE_BUILDING_REQUIRED'
  END AS command_signal,
  'NO_AUTOMATIC_POLICY_OR_FUNDING_ACTION' AS governance_constraint
FROM v_municipal_capital_decision_learning l;

COMMIT;
