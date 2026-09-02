BEGIN;

-- Comparative, evidence-gated benchmarking of endorsed capital decision patterns.
-- Advisory only; no policy, funding, or operational action is automated.
CREATE OR REPLACE VIEW v_municipal_capital_decision_performance_benchmark AS
WITH base AS (
  SELECT zone_id, selected_scenario_key,
         SUM(endorsed_decisions)::int AS endorsed_decisions,
         SUM(attributed_outcomes)::int AS attributed_outcomes,
         SUM(evidence_gaps)::int AS evidence_gaps,
         SUM(delivered_outcomes)::int AS delivered_outcomes,
         SUM(partial_outcomes)::int AS partial_outcomes,
         SUM(unsuccessful_outcomes)::int AS unsuccessful_outcomes,
         AVG(avg_observed_benefit_score) AS avg_observed_benefit_score,
         AVG(avg_health_delta) AS avg_health_delta,
         AVG(avg_reliability_delta) AS avg_reliability_delta,
         AVG(avg_work_order_delta) AS avg_work_order_delta,
         AVG(avg_sla_exposure_delta) AS avg_sla_exposure_delta,
         AVG(avg_penalty_delta_inr) AS avg_penalty_delta_inr
  FROM v_municipal_capital_decision_learning
  GROUP BY zone_id,selected_scenario_key
), ranked AS (
  SELECT b.*, COUNT(*) OVER (PARTITION BY selected_scenario_key) AS comparable_zone_count,
         AVG(avg_observed_benefit_score) OVER (PARTITION BY selected_scenario_key) AS theme_benchmark_benefit,
         AVG(CASE WHEN attributed_outcomes > 0 THEN 100.0*delivered_outcomes/attributed_outcomes END) OVER (PARTITION BY selected_scenario_key) AS theme_benchmark_delivery
  FROM base b
)
SELECT r.*,
       CASE WHEN r.attributed_outcomes < 2 THEN NULL
            ELSE ROUND(100.0*r.delivered_outcomes/NULLIF(r.attributed_outcomes,0),2) END AS delivery_rate,
       CASE WHEN r.attributed_outcomes < 2 THEN 'INSUFFICIENT_EVIDENCE'
            WHEN r.comparable_zone_count < 2 THEN 'INSUFFICIENT_COMPARISON'
            WHEN r.avg_observed_benefit_score > r.theme_benchmark_benefit + 5 THEN 'ABOVE_BENCHMARK'
            WHEN r.avg_observed_benefit_score < r.theme_benchmark_benefit - 5 THEN 'BELOW_BENCHMARK'
            ELSE 'NEAR_BENCHMARK' END AS benchmark_position,
       CASE WHEN r.attributed_outcomes < 2 THEN 'BUILD_MORE_DECISION_OUTCOME_EVIDENCE'
            WHEN r.comparable_zone_count < 2 THEN 'WAIT_FOR_COMPARABLE_DECISION_PATTERNS'
            WHEN r.avg_observed_benefit_score > r.theme_benchmark_benefit + 5 THEN 'REVIEW_FOR_CONTEXTUAL_REUSE'
            WHEN r.avg_observed_benefit_score < r.theme_benchmark_benefit - 5 THEN 'REVIEW_LOCAL_DECISION_DESIGN'
            ELSE 'MAINTAIN_CONTEXTUAL_REVIEW' END AS benchmark_guidance,
       'HUMAN_GOVERNED_COMPARATIVE_EVIDENCE' AS decision_authority
FROM ranked r;

CREATE OR REPLACE VIEW v_municipal_capital_decision_performance_summary AS
SELECT selected_scenario_key,benchmark_position,COUNT(*)::int AS zone_patterns,
       SUM(endorsed_decisions)::int AS endorsed_decisions,
       SUM(attributed_outcomes)::int AS attributed_outcomes,
       ROUND(AVG(avg_observed_benefit_score),2) AS avg_observed_benefit_score,
       ROUND(AVG(delivery_rate),2) AS avg_delivery_rate
FROM v_municipal_capital_decision_performance_benchmark
GROUP BY selected_scenario_key,benchmark_position;

CREATE OR REPLACE VIEW v_municipal_capital_decision_performance_command AS
SELECT b.*,
       CASE WHEN benchmark_position='ABOVE_BENCHMARK' THEN 'STRONG_PATTERN'
            WHEN benchmark_position='BELOW_BENCHMARK' THEN 'REVIEW_REQUIRED'
            WHEN benchmark_position='NEAR_BENCHMARK' THEN 'COMPARATIVE_MONITORING'
            ELSE 'EVIDENCE_BUILDING' END AS command_signal,
       'NO_AUTOMATIC_DECISION_OR_FUNDING_ACTION' AS governance_constraint
FROM v_municipal_capital_decision_performance_benchmark b;

COMMIT;
