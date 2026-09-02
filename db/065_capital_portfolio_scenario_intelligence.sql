BEGIN;

-- Advisory what-if analysis only. Scenarios are projections and never mutate
-- budgets, plans, programs, procurement, work orders, SLA, penalties, or assets.
CREATE OR REPLACE VIEW v_municipal_capital_portfolio_scenarios AS
WITH base AS (
  SELECT zone_id,zone_name,investment_theme,portfolio_review_score,
         capital_pressure_score,allocation_priority_score,
         uncommitted_budget_inr,expenditure_exposure_inr,
         assessed_programs,avg_effectiveness_index,learning_signal,
         high_replacement_assets,forecast_high_exposure_assets
  FROM v_municipal_capital_portfolio_optimization
), scenarios AS (
  SELECT 'CURRENT_MIX'::text AS scenario_key,0::numeric AS pressure_adjustment,0::numeric AS effectiveness_adjustment
  UNION ALL SELECT 'SHIFT_TO_ASSET_RENEWAL',-8,4
  UNION ALL SELECT 'SHIFT_TO_NETWORK_RESILIENCE',-10,2
  UNION ALL SELECT 'SHIFT_TO_PREVENTIVE_MAINTENANCE',-6,5
  UNION ALL SELECT 'SHIFT_TO_CONTRACTOR_CAPACITY',-4,3
)
SELECT b.zone_id,b.zone_name,b.investment_theme,s.scenario_key,
       b.portfolio_review_score AS baseline_score,
       ROUND(LEAST(100,GREATEST(0,b.portfolio_review_score+s.effectiveness_adjustment)),2) AS projected_review_score,
       ROUND(LEAST(100,GREATEST(0,b.capital_pressure_score+s.pressure_adjustment)),2) AS projected_capital_pressure_score,
       ROUND(LEAST(100,GREATEST(0,b.avg_effectiveness_index+s.effectiveness_adjustment)),2) AS projected_effectiveness_score,
       ROUND((b.portfolio_review_score-(LEAST(100,GREATEST(0,b.portfolio_review_score+s.effectiveness_adjustment)))),2) AS projected_score_change,
       b.allocation_priority_score,b.uncommitted_budget_inr,b.expenditure_exposure_inr,
       b.assessed_programs,b.learning_signal,b.high_replacement_assets,b.forecast_high_exposure_assets,
       CASE WHEN b.assessed_programs < 2 THEN 'INSUFFICIENT_EVIDENCE'
            WHEN s.scenario_key='CURRENT_MIX' THEN 'BASELINE'
            WHEN s.pressure_adjustment <= -8 AND s.effectiveness_adjustment >= 2 THEN 'FAVORABLE_HYPOTHESIS'
            ELSE 'MODERATE_HYPOTHESIS' END AS scenario_state,
       'ILLUSTRATIVE_SCENARIO_NOT_A_FORECAST' AS forecast_authority,
       'HUMAN_DECISION_REQUIRED' AS governance_state
FROM base b CROSS JOIN scenarios s;

CREATE OR REPLACE VIEW v_municipal_capital_portfolio_scenario_summary AS
SELECT zone_id,zone_name,scenario_key,
       ROUND(AVG(projected_review_score),2) AS avg_projected_review_score,
       ROUND(AVG(projected_capital_pressure_score),2) AS avg_projected_capital_pressure_score,
       ROUND(AVG(projected_effectiveness_score),2) AS avg_projected_effectiveness_score,
       ROUND(AVG(projected_score_change),2) AS avg_score_change,
       COUNT(*)::int AS theme_count,
       COUNT(*) FILTER (WHERE scenario_state='FAVORABLE_HYPOTHESIS')::int AS favorable_hypotheses,
       COUNT(*) FILTER (WHERE scenario_state='INSUFFICIENT_EVIDENCE')::int AS insufficient_evidence_themes
FROM v_municipal_capital_portfolio_scenarios
GROUP BY zone_id,zone_name,scenario_key;

CREATE OR REPLACE VIEW v_municipal_capital_portfolio_scenario_command AS
SELECT s.*,
       CASE WHEN s.scenario_key='CURRENT_MIX' THEN 'BASELINE_REVIEW'
            WHEN s.favorable_hypotheses > 0 AND s.insufficient_evidence_themes=0 THEN 'SCENARIO_REVIEW_CANDIDATE'
            WHEN s.insufficient_evidence_themes > 0 THEN 'EVIDENCE_REVIEW_REQUIRED'
            ELSE 'CONTEXT_REVIEW_REQUIRED' END AS command_signal,
       'ADVISORY_ONLY' AS decision_authority
FROM v_municipal_capital_portfolio_scenario_summary s;

COMMIT;
