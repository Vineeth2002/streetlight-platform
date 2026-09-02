BEGIN;

-- Advisory guidance from historical scenario/program learning.
-- This layer never selects a scenario, creates a program, allocates funding, or mutates operations.
CREATE OR REPLACE VIEW v_municipal_capital_scenario_learning_guidance AS
WITH scenarios AS (
  SELECT scenario_key,scenario_state,zone_id,zone_name,investment_theme,
         baseline_score,projected_review_score,projected_capital_pressure_score,
         projected_effectiveness_score,projected_score_change,
         high_replacement_assets,forecast_high_exposure_assets
  FROM v_municipal_capital_portfolio_scenarios
), learning AS (
  SELECT * FROM v_municipal_capital_scenario_program_learning
)
SELECT
  s.scenario_key,s.scenario_state,s.zone_id,s.zone_name,s.investment_theme,
  s.baseline_score,s.projected_review_score,s.projected_capital_pressure_score,
  s.projected_effectiveness_score,s.projected_score_change,
  s.high_replacement_assets,s.forecast_high_exposure_assets,
  COALESCE(l.programs_observed,0) AS programs_observed,
  COALESCE(l.attribution_records,0) AS attribution_records,
  COALESCE(l.attributed_outcomes,0) AS attributed_outcomes,
  COALESCE(l.evidence_gaps,0) AS evidence_gaps,
  COALESCE(l.delivered_outcomes,0) AS delivered_outcomes,
  COALESCE(l.partial_outcomes,0) AS partial_outcomes,
  COALESCE(l.unsuccessful_outcomes,0) AS unsuccessful_outcomes,
  COALESCE(l.avg_observed_benefit_score,0) AS avg_observed_benefit_score,
  COALESCE(l.avg_health_delta,0) AS avg_health_delta,
  COALESCE(l.avg_reliability_delta,0) AS avg_reliability_delta,
  l.learning_signal,
  CASE
    WHEN COALESCE(l.attributed_outcomes,0)=0 THEN 'NO_HISTORICAL_OUTCOME_EVIDENCE'
    WHEN l.attributed_outcomes<2 THEN 'INSUFFICIENT_HISTORICAL_EVIDENCE'
    WHEN l.learning_signal='POSITIVE_PATTERN' THEN 'HISTORICAL_POSITIVE_PATTERN'
    WHEN l.learning_signal='NEGATIVE_PATTERN' THEN 'HISTORICAL_NEGATIVE_PATTERN'
    WHEN l.learning_signal='MIXED_PATTERN' THEN 'HISTORICAL_MIXED_PATTERN'
    ELSE 'HISTORICAL_EVIDENCE_REQUIRES_REVIEW'
  END AS guidance_state,
  CASE
    WHEN COALESCE(l.attributed_outcomes,0)=0 THEN 'BUILD_OUTCOME_EVIDENCE_BEFORE_REUSE'
    WHEN l.attributed_outcomes<2 THEN 'REVIEW_ADDITIONAL_HISTORICAL_OUTCOMES'
    WHEN l.learning_signal='POSITIVE_PATTERN' THEN 'CONSIDER_SCENARIO_WITH_CURRENT_CONTEXT_REVIEW'
    WHEN l.learning_signal='NEGATIVE_PATTERN' THEN 'REVIEW_ASSUMPTIONS_BEFORE_CONSIDERATION'
    WHEN l.learning_signal='MIXED_PATTERN' THEN 'COMPARE_CONTEXT_AND_RISK_BEFORE_CONSIDERATION'
    ELSE 'HUMAN_STRATEGIC_REVIEW_REQUIRED'
  END AS guidance_recommendation,
  'HUMAN_REVIEW_REQUIRED' AS decision_authority,
  'NO_AUTOMATIC_SCENARIO_SELECTION' AS governance_constraint
FROM scenarios s
LEFT JOIN learning l ON l.scenario_key=s.scenario_key AND l.zone_id IS NOT DISTINCT FROM s.zone_id;

CREATE OR REPLACE VIEW v_municipal_capital_scenario_learning_guidance_summary AS
SELECT zone_id,zone_name,guidance_state,COUNT(*)::int AS scenarios,
  COUNT(*) FILTER (WHERE attributed_outcomes>0)::int AS scenarios_with_outcome_evidence,
  COUNT(*) FILTER (WHERE guidance_state='HISTORICAL_POSITIVE_PATTERN')::int AS positive_patterns,
  COUNT(*) FILTER (WHERE guidance_state='HISTORICAL_MIXED_PATTERN')::int AS mixed_patterns,
  COUNT(*) FILTER (WHERE guidance_state='HISTORICAL_NEGATIVE_PATTERN')::int AS negative_patterns,
  COUNT(*) FILTER (WHERE guidance_state IN ('NO_HISTORICAL_OUTCOME_EVIDENCE','INSUFFICIENT_HISTORICAL_EVIDENCE'))::int AS evidence_limited
FROM v_municipal_capital_scenario_learning_guidance
GROUP BY zone_id,zone_name,guidance_state;

COMMIT;
