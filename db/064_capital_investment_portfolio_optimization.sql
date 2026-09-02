BEGIN;

-- Advisory portfolio trade-off intelligence. This layer does not allocate,
-- approve, fund, reprioritize, or execute capital automatically.
CREATE OR REPLACE VIEW v_municipal_capital_portfolio_optimization AS
WITH command AS (
  SELECT zone_id,zone_name,capital_pressure_score,allocation_priority_score,
         high_replacement_assets,forecast_high_exposure_assets,
         uncommitted_budget_inr,expenditure_exposure_inr,capital_review_band
  FROM v_municipal_capital_command
), benchmark AS (
  SELECT investment_theme,zone_id,zone_name,assessed_programs,
         avg_effectiveness_index,avg_benefit_score,avg_health_delta,
         avg_reliability_delta,avg_verification_rate
  FROM v_municipal_capital_investment_effectiveness_summary
), guidance AS (
  SELECT investment_theme,zone_id,learning_signal,measured_programs,
         effectiveness_rate,avg_benefit_score AS learning_avg_benefit_score,
         plan_guidance
  FROM v_municipal_capital_strategy_to_plan_guidance
), themes AS (
  SELECT DISTINCT investment_theme FROM municipal_capital_plans
  UNION
  SELECT DISTINCT investment_theme FROM v_municipal_capital_program_learning_patterns
)
SELECT c.zone_id,c.zone_name,t.investment_theme,
       c.capital_pressure_score,c.allocation_priority_score,
       c.high_replacement_assets,c.forecast_high_exposure_assets,
       c.uncommitted_budget_inr,c.expenditure_exposure_inr,c.capital_review_band,
       COALESCE(b.assessed_programs,0) AS assessed_programs,
       b.avg_effectiveness_index,b.avg_benefit_score,b.avg_health_delta,
       b.avg_reliability_delta,b.avg_verification_rate,
       g.learning_signal,g.measured_programs,g.effectiveness_rate,
       g.plan_guidance,
       CASE g.learning_signal
         WHEN 'RETAIN' THEN 100
         WHEN 'REVIEW' THEN 60
         WHEN 'REVISE' THEN 35
         ELSE 15
       END AS strategy_readiness_score,
       CASE WHEN b.avg_effectiveness_index IS NULL THEN 0
            ELSE b.avg_effectiveness_index END AS evidence_effectiveness_score,
       ROUND(LEAST(100,
         c.capital_pressure_score*0.45
         + (CASE WHEN b.avg_effectiveness_index IS NULL THEN 0 ELSE b.avg_effectiveness_index END)*0.30
         + CASE g.learning_signal WHEN 'RETAIN' THEN 25 WHEN 'REVIEW' THEN 15 WHEN 'REVISE' THEN 8 ELSE 3 END
       ),2) AS portfolio_review_score,
       CASE
         WHEN b.assessed_programs < 2 THEN 'EVIDENCE_BUILDING'
         WHEN g.learning_signal='RETAIN' AND c.capital_pressure_score >= 50 THEN 'HIGH_VALUE_REVIEW'
         WHEN g.learning_signal='RETAIN' THEN 'VALUE_REVIEW'
         WHEN g.learning_signal='REVISE' AND c.capital_pressure_score >= 50 THEN 'RISK_WITH_DESIGN_REVIEW'
         WHEN c.capital_pressure_score >= 75 THEN 'PRESSURE_REVIEW'
         ELSE 'BALANCED_REVIEW'
       END AS portfolio_review_state,
       'HUMAN_PORTFOLIO_DECISION_REQUIRED' AS governance_state
FROM command c
CROSS JOIN themes t
LEFT JOIN benchmark b ON b.zone_id IS NOT DISTINCT FROM c.zone_id AND b.investment_theme=t.investment_theme
LEFT JOIN guidance g ON g.zone_id IS NOT DISTINCT FROM c.zone_id AND g.investment_theme=t.investment_theme;

CREATE OR REPLACE VIEW v_municipal_capital_portfolio_optimization_summary AS
SELECT zone_id,zone_name,COUNT(*)::int AS theme_options,
       ROUND(MAX(portfolio_review_score),2) AS top_review_score,
       COUNT(*) FILTER (WHERE portfolio_review_state='HIGH_VALUE_REVIEW')::int AS high_value_review_options,
       COUNT(*) FILTER (WHERE portfolio_review_state='EVIDENCE_BUILDING')::int AS evidence_building_options,
       COUNT(*) FILTER (WHERE portfolio_review_state IN ('PRESSURE_REVIEW','RISK_WITH_DESIGN_REVIEW'))::int AS pressure_or_risk_options,
       MAX(capital_pressure_score) AS capital_pressure_score,
       MAX(uncommitted_budget_inr) AS uncommitted_budget_inr,
       MAX(expenditure_exposure_inr) AS expenditure_exposure_inr
FROM v_municipal_capital_portfolio_optimization
GROUP BY zone_id,zone_name;

CREATE OR REPLACE VIEW v_municipal_capital_portfolio_optimization_command AS
SELECT s.*,
       CASE WHEN s.high_value_review_options > 0 AND s.pressure_or_risk_options > 0 THEN 'TRADEOFF_REVIEW_REQUIRED'
            WHEN s.high_value_review_options > 0 THEN 'VALUE_FOCUSED_REVIEW'
            WHEN s.pressure_or_risk_options > 0 THEN 'RISK_FOCUSED_REVIEW'
            ELSE 'EVIDENCE_AND_BALANCE_REVIEW' END AS portfolio_command_signal,
       'ADVISORY_ONLY' AS decision_authority
FROM v_municipal_capital_portfolio_optimization_summary s;

COMMIT;
