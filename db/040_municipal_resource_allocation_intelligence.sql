-- 040_municipal_resource_allocation_intelligence.sql
-- Advisory resource-allocation prioritisation. It ranks review candidates only;
-- it does not allocate crews, money, contracts, work orders, or change operations.

CREATE OR REPLACE VIEW v_municipal_resource_allocation AS
WITH risk AS (
  SELECT * FROM v_municipal_risk_forecast_clusters
),
workload AS (
  SELECT c.assigned_zone_id AS zone_id,
         COALESCE(SUM(c.active_crews_deployed),0)::int AS active_crews,
         COALESCE(SUM(c.total_pending),0)::int AS contractor_pending_orders,
         COALESCE(SUM(c.total_solved_daily),0)::int AS contractor_solved_daily
  FROM contractors c
  GROUP BY c.assigned_zone_id
),
budget AS (
  SELECT b.zone_id,
         SUM(GREATEST(COALESCE(b.revised_amount_inr,b.allocated_amount_inr)-COALESCE(x.committed_amount_inr,0),0)) AS uncommitted_budget_inr
  FROM municipal_budgets b
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(bcc.committed_amount_inr) FILTER (WHERE bcc.status IN ('PLANNED','ACTIVE')),0) AS committed_amount_inr
    FROM budget_contract_commitments bcc WHERE bcc.budget_id=b.budget_id
  ) x ON TRUE
  WHERE b.status='ACTIVE'
  GROUP BY b.zone_id
),
scored AS (
  SELECT r.*,COALESCE(w.active_crews,0) AS active_crews,COALESCE(w.contractor_pending_orders,0) AS contractor_pending_orders,
         COALESCE(w.contractor_solved_daily,0) AS contractor_solved_daily,COALESCE(b.uncommitted_budget_inr,0) AS uncommitted_budget_inr,
         ROUND(LEAST(100,GREATEST(0,
           (CASE r.forecast_30d_band WHEN 'CRITICAL_EXPOSURE' THEN 35 WHEN 'HIGH_EXPOSURE' THEN 25 WHEN 'MEDIUM_EXPOSURE' THEN 15 ELSE 5 END)+
           (CASE r.forecast_direction WHEN 'DETERIORATING' THEN 25 WHEN 'STABLE' THEN 10 WHEN 'IMPROVING' THEN 0 ELSE 5 END)+
           (CASE WHEN r.critical_exposure_30d>0 THEN 20 ELSE 0 END)+
           (CASE WHEN r.high_exposure_30d>0 THEN 10 ELSE 0 END)+
           (CASE WHEN COALESCE(w.active_crews,0)=0 AND r.zone_id IS NOT NULL THEN 10 ELSE 0 END))),2) AS allocation_priority_score
  FROM risk r LEFT JOIN workload w ON w.zone_id=r.zone_id LEFT JOIN budget b ON b.zone_id=r.zone_id
)
SELECT s.*,
  CASE WHEN allocation_priority_score>=75 THEN 'IMMEDIATE_REVIEW'
       WHEN allocation_priority_score>=50 THEN 'HIGH_REVIEW'
       WHEN allocation_priority_score>=30 THEN 'PLANNING_REVIEW'
       ELSE 'ROUTINE_REVIEW' END AS allocation_review_band,
  CASE WHEN active_crews=0 AND forecast_30d_band IN ('CRITICAL_EXPOSURE','HIGH_EXPOSURE') THEN 'CAPACITY_GAP'
       WHEN uncommitted_budget_inr<=0 AND forecast_30d_band IN ('CRITICAL_EXPOSURE','HIGH_EXPOSURE') THEN 'BUDGET_PRESSURE'
       WHEN contractor_pending_orders>contractor_solved_daily*7 AND contractor_solved_daily>0 THEN 'WORKLOAD_PRESSURE'
       ELSE 'NO_PRIMARY_CONSTRAINT' END AS primary_resource_constraint
FROM scored;

CREATE OR REPLACE VIEW v_municipal_resource_allocation_summary AS
SELECT zone_id,COUNT(*)::int AS clusters,SUM(assets)::int AS assets,
       ROUND(AVG(allocation_priority_score),2) AS avg_priority_score,
       SUM(critical_exposure_30d)::int AS critical_exposure_30d,
       SUM(high_exposure_30d)::int AS high_exposure_30d,
       MAX(active_crews)::int AS active_crews,
       MAX(contractor_pending_orders)::int AS contractor_pending_orders,
       MAX(contractor_solved_daily)::int AS contractor_solved_daily,
       MAX(uncommitted_budget_inr) AS uncommitted_budget_inr,
       COUNT(*) FILTER(WHERE allocation_review_band='IMMEDIATE_REVIEW')::int AS immediate_review_clusters,
       COUNT(*) FILTER(WHERE primary_resource_constraint='CAPACITY_GAP')::int AS capacity_gap_clusters,
       COUNT(*) FILTER(WHERE primary_resource_constraint='BUDGET_PRESSURE')::int AS budget_pressure_clusters
FROM v_municipal_resource_allocation
GROUP BY zone_id;

CREATE INDEX IF NOT EXISTS idx_resource_allocation_workorders_contractor ON work_orders(contractor_id,ticket_status);
CREATE INDEX IF NOT EXISTS idx_resource_allocation_contractors_zone ON contractors(assigned_zone_id,active_crews_deployed);
