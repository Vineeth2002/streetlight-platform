-- 039_municipal_risk_scenario_intelligence.sql
-- Advisory what-if intelligence. Scenarios are read-only projections and never
-- create work orders, alter assets, change budgets, or execute interventions.

CREATE OR REPLACE VIEW v_municipal_risk_scenario_baseline AS
SELECT c.cluster_type,c.cluster_key,c.zone_id,c.ward_id,c.road_name,c.assets,
       c.current_command_risk_score,c.current_command_risk_band,c.avg_composite_score_7d,c.avg_composite_score_30d,
       c.forecast_30d_band,c.forecast_direction,c.forecast_command_risk_30d
FROM v_municipal_risk_forecast_command c;

CREATE OR REPLACE VIEW v_municipal_risk_scenario_options AS
WITH b AS (SELECT * FROM v_municipal_risk_scenario_baseline),
options AS (
  SELECT b.*,'NO_ACTION'::varchar AS scenario_type,0::numeric AS assumed_improvement_pct FROM b
  UNION ALL SELECT b.*,'TARGETED_INTERVENTION',15::numeric FROM b
  UNION ALL SELECT b.*,'ACCELERATED_INTERVENTION',30::numeric FROM b
  UNION ALL SELECT b.*,'REPLACEMENT_PROGRAM',45::numeric FROM b
), projected AS (
  SELECT o.*,
    ROUND(GREATEST(0,LEAST(100,o.avg_composite_score_30d + (o.assumed_improvement_pct * (100-o.avg_composite_score_30d)/100))),2) AS projected_score_30d
  FROM options o
)
SELECT p.*,
  ROUND(p.forecast_command_risk_30d * (1-(p.assumed_improvement_pct/100)*0.70),2) AS projected_command_risk_30d,
  ROUND(p.forecast_command_risk_30d - (p.forecast_command_risk_30d * (p.assumed_improvement_pct/100)*0.70),2) AS estimated_risk_reduction,
  CASE WHEN p.scenario_type='NO_ACTION' THEN 'BASELINE'
       WHEN p.assumed_improvement_pct >= 45 THEN 'HIGH_IMPACT'
       WHEN p.assumed_improvement_pct >= 30 THEN 'MEDIUM_HIGH_IMPACT'
       ELSE 'TARGETED_IMPACT' END AS scenario_impact_band
FROM projected p;

CREATE OR REPLACE VIEW v_municipal_risk_scenario_command AS
SELECT o.cluster_type,o.cluster_key,o.zone_id,o.ward_id,o.road_name,o.assets,
       o.current_command_risk_band,o.forecast_30d_band,o.forecast_direction,
       o.scenario_type,o.assumed_improvement_pct,o.projected_score_30d,
       o.forecast_command_risk_30d,o.projected_command_risk_30d,o.estimated_risk_reduction,o.scenario_impact_band,
       CASE WHEN o.scenario_type<>'NO_ACTION' AND o.estimated_risk_reduction >= 15 THEN 'STRONG_REVIEW_CANDIDATE'
            WHEN o.scenario_type<>'NO_ACTION' AND o.estimated_risk_reduction >= 7 THEN 'REVIEW_CANDIDATE'
            WHEN o.scenario_type='NO_ACTION' AND o.forecast_30d_band IN ('CRITICAL_EXPOSURE','HIGH_EXPOSURE') THEN 'BASELINE_HIGH_EXPOSURE'
            ELSE 'MONITOR' END AS scenario_review_state
FROM v_municipal_risk_scenario_options o;

CREATE INDEX IF NOT EXISTS idx_scenario_health_history ON asset_health_snapshots(pole_id,as_of DESC,health_score);
CREATE INDEX IF NOT EXISTS idx_scenario_reliability_history ON asset_reliability_snapshots(pole_id,as_of DESC,risk_score);
