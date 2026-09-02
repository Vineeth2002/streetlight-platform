BEGIN;

-- Advisory benchmarking only. No budget, funding, procurement, work-order,
-- SLA, penalty, or glow-rate behavior is changed.
CREATE OR REPLACE VIEW v_municipal_capital_investment_effectiveness_benchmark AS
WITH assessed AS (
  SELECT cp.capital_program_id,cp.program_key,cp.title,cp.investment_theme,cp.zone_id,z.zone_name,
         o.observed_benefit_score,o.health_delta,o.reliability_delta,
         o.work_order_delta,o.sla_exposure_delta,o.penalty_delta_inr,
         e.linked_assets,e.linked_work_orders,e.verified_work_orders,
         e.current_avg_health_score,e.current_avg_reliability_score,
         e.current_open_work_orders,e.current_sla_exposure,
         CASE WHEN e.linked_work_orders > 0 THEN ROUND(100.0*e.verified_work_orders/e.linked_work_orders,2) ELSE NULL END AS verification_rate
  FROM municipal_capital_programs cp
  JOIN v_municipal_capital_program_outcomes o ON o.capital_program_id=cp.capital_program_id
  LEFT JOIN v_municipal_capital_program_outcome_asset_evidence e ON e.capital_program_id=cp.capital_program_id
  LEFT JOIN zones z ON z.zone_id=cp.zone_id
  WHERE o.outcome_band IN ('DELIVERED','PARTIAL','NO_MEASURABLE_BENEFIT')
), scored AS (
  SELECT a.*,
         CASE WHEN a.observed_benefit_score IS NULL THEN NULL
              ELSE ROUND((a.observed_benefit_score*0.50
                    + GREATEST(0,LEAST(100,50+a.health_delta))*0.20
                    + GREATEST(0,LEAST(100,50+a.reliability_delta))*0.20
                    + COALESCE(a.verification_rate,0)*0.10),2) END AS effectiveness_index
  FROM assessed a
)
SELECT s.*,
       COUNT(*) OVER (PARTITION BY s.investment_theme) AS theme_benchmark_count,
       ROUND(AVG(s.effectiveness_index) OVER (PARTITION BY s.investment_theme),2) AS theme_avg_effectiveness_index,
       COUNT(*) OVER (PARTITION BY s.zone_id) AS zone_benchmark_count,
       ROUND(AVG(s.effectiveness_index) OVER (PARTITION BY s.zone_id),2) AS zone_avg_effectiveness_index,
       CASE WHEN s.effectiveness_index IS NULL THEN 'INSUFFICIENT_EVIDENCE'
            WHEN s.effectiveness_index >= COALESCE(AVG(s.effectiveness_index) OVER (PARTITION BY s.investment_theme),s.effectiveness_index)+10 THEN 'ABOVE_THEME_BENCHMARK'
            WHEN s.effectiveness_index <= COALESCE(AVG(s.effectiveness_index) OVER (PARTITION BY s.investment_theme),s.effectiveness_index)-10 THEN 'BELOW_THEME_BENCHMARK'
            ELSE 'NEAR_THEME_BENCHMARK' END AS benchmark_position
FROM scored s;

CREATE OR REPLACE VIEW v_municipal_capital_investment_effectiveness_summary AS
SELECT investment_theme,zone_id,zone_name,COUNT(*)::int AS assessed_programs,
       ROUND(AVG(effectiveness_index),2) AS avg_effectiveness_index,
       ROUND(AVG(observed_benefit_score),2) AS avg_benefit_score,
       ROUND(AVG(health_delta),2) AS avg_health_delta,
       ROUND(AVG(reliability_delta),2) AS avg_reliability_delta,
       ROUND(AVG(verification_rate),2) AS avg_verification_rate,
       COUNT(*) FILTER (WHERE benchmark_position='ABOVE_THEME_BENCHMARK')::int AS above_theme_benchmark,
       COUNT(*) FILTER (WHERE benchmark_position='BELOW_THEME_BENCHMARK')::int AS below_theme_benchmark
FROM v_municipal_capital_investment_effectiveness_benchmark
GROUP BY investment_theme,zone_id,zone_name;

CREATE OR REPLACE VIEW v_municipal_capital_investment_effectiveness_command AS
SELECT s.*,CASE WHEN s.avg_effectiveness_index >= 70 THEN 'STRONG_OUTCOME_PATTERN'
                WHEN s.avg_effectiveness_index >= 50 THEN 'MIXED_OUTCOME_PATTERN'
                WHEN s.avg_effectiveness_index IS NULL THEN 'INSUFFICIENT_EVIDENCE'
                ELSE 'WEAK_OUTCOME_PATTERN' END AS benchmark_signal,
       CASE WHEN s.assessed_programs < 2 THEN 'INSUFFICIENT_COMPARISON'
            ELSE 'COMPARATIVE_REVIEW_AVAILABLE' END AS comparison_state
FROM v_municipal_capital_investment_effectiveness_summary s;

COMMIT;
