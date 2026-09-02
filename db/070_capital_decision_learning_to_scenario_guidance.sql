BEGIN;

-- Feeds validated decision-learning evidence back into future portfolio scenarios.
-- Advisory only: no scenario is selected, funded, or executed automatically.
CREATE OR REPLACE VIEW v_municipal_capital_decision_learning_scenario_guidance AS
WITH learning AS (
  SELECT zone_id,selected_scenario_key,learning_signal,learning_guidance,
         endorsed_decisions,attributed_outcomes,evidence_gaps,
         avg_observed_benefit_score,avg_health_delta,avg_reliability_delta,
         avg_work_order_delta,avg_sla_exposure_delta,avg_penalty_delta_inr
  FROM v_municipal_capital_decision_learning
), scenarios AS (
  SELECT s.zone_id,s.zone_name,s.scenario_key,s.scenario_label,
         s.baseline_review_score,s.projected_review_score,s.score_change,
         s.allocation_priority_score,s.scenario_state
  FROM v_municipal_capital_portfolio_scenarios s
)
SELECT
  s.zone_id,s.zone_name,s.scenario_key,s.scenario_label,
  s.baseline_review_score,s.projected_review_score,s.score_change,
  s.allocation_priority_score,s.scenario_state,
  l.learning_signal,l.learning_guidance,l.endorsed_decisions,
  l.attributed_outcomes,l.evidence_gaps,l.avg_observed_benefit_score,
  l.avg_health_delta,l.avg_reliability_delta,l.avg_work_order_delta,
  l.avg_sla_exposure_delta,l.avg_penalty_delta_inr,
  CASE
    WHEN l.learning_signal='RETAIN' AND l.selected_scenario_key=s.scenario_key THEN 'LEARNING_SUPPORTED'
    WHEN l.learning_signal='REVISE' AND l.selected_scenario_key=s.scenario_key THEN 'LEARNING_CAUTION'
    WHEN l.learning_signal='REVIEW' AND l.selected_scenario_key=s.scenario_key THEN 'CONTEXT_REVIEW_REQUIRED'
    WHEN l.learning_signal='INSUFFICIENT_EVIDENCE' AND l.selected_scenario_key=s.scenario_key THEN 'EVIDENCE_BUILDING_REQUIRED'
    WHEN l.learning_signal IS NULL THEN 'NO_PRIOR_DECISION_EVIDENCE'
    ELSE 'NO_DIRECT_LEARNING_MATCH'
  END AS guidance_state,
  CASE
    WHEN l.learning_signal='RETAIN' AND l.selected_scenario_key=s.scenario_key THEN 'CONSIDER_REUSE_AFTER_CONTEXT_REVIEW'
    WHEN l.learning_signal='REVISE' AND l.selected_scenario_key=s.scenario_key THEN 'REVIEW_DESIGN_BEFORE_REUSE'
    WHEN l.learning_signal='REVIEW' AND l.selected_scenario_key=s.scenario_key THEN 'COMPARE_LOCAL_CONTEXT_AND_EVIDENCE'
    WHEN l.learning_signal='INSUFFICIENT_EVIDENCE' AND l.selected_scenario_key=s.scenario_key THEN 'COLLECT_MORE_OUTCOME_EVIDENCE'
    ELSE 'NO_LEARNING_BASED_GUIDANCE'
  END AS recommended_review,
  'HUMAN_REVIEW_REQUIRED' AS decision_authority,
  'NO_AUTOMATIC_SCENARIO_SELECTION' AS governance_constraint
FROM scenarios s
LEFT JOIN learning l
  ON l.zone_id IS NOT DISTINCT FROM s.zone_id
 AND l.selected_scenario_key=s.scenario_key;

CREATE OR REPLACE VIEW v_municipal_capital_decision_learning_scenario_summary AS
SELECT zone_id,zone_name,scenario_key,guidance_state,
       COUNT(*)::int AS scenario_records,
       COUNT(*) FILTER (WHERE guidance_state='LEARNING_SUPPORTED')::int AS learning_supported,
       COUNT(*) FILTER (WHERE guidance_state='LEARNING_CAUTION')::int AS learning_caution,
       COUNT(*) FILTER (WHERE guidance_state='CONTEXT_REVIEW_REQUIRED')::int AS context_review_required,
       COUNT(*) FILTER (WHERE guidance_state='EVIDENCE_BUILDING_REQUIRED')::int AS evidence_building_required
FROM v_municipal_capital_decision_learning_scenario_guidance
GROUP BY zone_id,zone_name,scenario_key,guidance_state;

COMMIT;
