-- 041_municipal_program_portfolio_intelligence.sql
-- Advisory program and portfolio intelligence. It groups existing risk/resource
-- priorities into management-review programs; it never creates or executes work.

CREATE OR REPLACE VIEW v_municipal_program_portfolio AS
WITH base AS (
  SELECT r.*,
    CASE
      WHEN r.primary_resource_constraint='CAPACITY_GAP' THEN 'CONTRACTOR_RECOVERY_PROGRAM'
      WHEN r.primary_resource_constraint='BUDGET_PRESSURE' THEN 'CAPITAL_BUDGET_REVIEW_PROGRAM'
      WHEN r.forecast_30d_band='CRITICAL_EXPOSURE' AND r.forecast_direction='DETERIORATING' THEN 'URGENT_FAILURE_REDUCTION_PROGRAM'
      WHEN r.forecast_30d_band IN ('CRITICAL_EXPOSURE','HIGH_EXPOSURE') THEN 'TARGETED_RISK_REDUCTION_PROGRAM'
      WHEN r.forecast_direction='DETERIORATING' THEN 'PREVENTIVE_INTERVENTION_PROGRAM'
      ELSE 'ROUTINE_ASSET_REVIEW_PROGRAM'
    END AS program_type
  FROM v_municipal_resource_allocation r
),
portfolio AS (
  SELECT b.program_type,b.zone_id,b.cluster_type,b.cluster_key,b.ward_id,b.road_name,
         b.assets,b.allocation_priority_score,b.allocation_review_band,b.primary_resource_constraint,
         b.forecast_30d_band,b.forecast_direction,b.critical_exposure_30d,b.high_exposure_30d,
         b.active_crews,b.contractor_pending_orders,b.contractor_solved_daily,b.uncommitted_budget_inr
  FROM base b
)
SELECT p.*,
  ROUND(LEAST(100,GREATEST(0,
    p.allocation_priority_score
    + CASE p.program_type
        WHEN 'URGENT_FAILURE_REDUCTION_PROGRAM' THEN 10
        WHEN 'CONTRACTOR_RECOVERY_PROGRAM' THEN 8
        WHEN 'CAPITAL_BUDGET_REVIEW_PROGRAM' THEN 6
        WHEN 'TARGETED_RISK_REDUCTION_PROGRAM' THEN 4
        ELSE 0 END)),2) AS program_priority_score,
  CASE
    WHEN p.program_type='URGENT_FAILURE_REDUCTION_PROGRAM' THEN 'IMMEDIATE_PORTFOLIO_REVIEW'
    WHEN p.allocation_review_band='IMMEDIATE_REVIEW' THEN 'IMMEDIATE_PORTFOLIO_REVIEW'
    WHEN p.allocation_review_band='HIGH_REVIEW' THEN 'HIGH_PORTFOLIO_REVIEW'
    WHEN p.allocation_review_band='PLANNING_REVIEW' THEN 'PLANNING_PORTFOLIO_REVIEW'
    ELSE 'ROUTINE_PORTFOLIO_REVIEW'
  END AS portfolio_review_state
FROM portfolio p;

CREATE OR REPLACE VIEW v_municipal_program_portfolio_summary AS
SELECT program_type,zone_id,
       COUNT(*)::int AS review_items,
       SUM(assets)::int AS assets,
       ROUND(AVG(program_priority_score),2) AS avg_program_priority_score,
       ROUND(MAX(program_priority_score),2) AS max_program_priority_score,
       SUM(critical_exposure_30d)::int AS critical_exposure_30d,
       SUM(high_exposure_30d)::int AS high_exposure_30d,
       SUM(contractor_pending_orders)::int AS contractor_pending_orders,
       MAX(active_crews)::int AS active_crews,
       MAX(uncommitted_budget_inr) AS uncommitted_budget_inr,
       COUNT(*) FILTER (WHERE portfolio_review_state='IMMEDIATE_PORTFOLIO_REVIEW')::int AS immediate_review_items,
       COUNT(*) FILTER (WHERE primary_resource_constraint='CAPACITY_GAP')::int AS capacity_gap_items,
       COUNT(*) FILTER (WHERE primary_resource_constraint='BUDGET_PRESSURE')::int AS budget_pressure_items
FROM v_municipal_program_portfolio
GROUP BY program_type,zone_id;

CREATE OR REPLACE VIEW v_municipal_program_portfolio_command AS
SELECT program_type,zone_id,
       SUM(assets)::int AS assets,
       COUNT(*)::int AS review_items,
       ROUND(AVG(program_priority_score),2) AS avg_priority_score,
       ROUND(MAX(program_priority_score),2) AS max_priority_score,
       SUM(critical_exposure_30d)::int AS critical_exposure_30d,
       SUM(high_exposure_30d)::int AS high_exposure_30d,
       SUM(contractor_pending_orders)::int AS contractor_pending_orders,
       COUNT(*) FILTER (WHERE portfolio_review_state='IMMEDIATE_PORTFOLIO_REVIEW')::int AS immediate_review_items,
       COUNT(*) FILTER (WHERE portfolio_review_state='HIGH_PORTFOLIO_REVIEW')::int AS high_review_items,
       COUNT(*) FILTER (WHERE primary_resource_constraint='CAPACITY_GAP')::int AS capacity_gap_items,
       COUNT(*) FILTER (WHERE primary_resource_constraint='BUDGET_PRESSURE')::int AS budget_pressure_items,
       CASE WHEN MAX(program_priority_score)>=75 THEN 'IMMEDIATE'
            WHEN MAX(program_priority_score)>=50 THEN 'HIGH'
            WHEN MAX(program_priority_score)>=30 THEN 'PLANNING'
            ELSE 'ROUTINE' END AS command_review_band
FROM v_municipal_program_portfolio
GROUP BY program_type,zone_id;

CREATE INDEX IF NOT EXISTS idx_program_portfolio_workorders_status ON work_orders(ticket_status,contractor_id);
CREATE INDEX IF NOT EXISTS idx_program_portfolio_poles_status ON poles(current_status,road_name);
