BEGIN;

ALTER TABLE municipal_capital_program_outcome_assessments
  ADD COLUMN IF NOT EXISTS execution_snapshot_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS linked_asset_count_at INT CHECK (linked_asset_count_at >= 0),
  ADD COLUMN IF NOT EXISTS linked_work_order_count_at INT CHECK (linked_work_order_count_at >= 0),
  ADD COLUMN IF NOT EXISTS verified_work_order_count_at INT CHECK (verified_work_order_count_at >= 0),
  ADD COLUMN IF NOT EXISTS before_evidence_count_at INT CHECK (before_evidence_count_at >= 0),
  ADD COLUMN IF NOT EXISTS after_evidence_count_at INT CHECK (after_evidence_count_at >= 0),
  ADD COLUMN IF NOT EXISTS execution_evidence_state VARCHAR(32)
    CHECK (execution_evidence_state IN ('NO_LINKED_ASSETS','EXECUTION_INCOMPLETE','EXECUTION_VERIFIED','EXECUTION_MIXED')),
  ADD COLUMN IF NOT EXISTS asset_outcome_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE VIEW v_municipal_capital_program_outcome_asset_evidence AS
WITH links AS (
  SELECT l.capital_program_id,l.pole_id,l.work_order_id,l.linkage_type,
         cp.zone_id
  FROM municipal_capital_program_asset_links l
  JOIN municipal_capital_programs cp ON cp.capital_program_id=l.capital_program_id
), latest_health AS (
  SELECT DISTINCT ON (pole_id) pole_id,as_of,health_score,health_band
  FROM asset_health_snapshots
  ORDER BY pole_id,as_of DESC
), latest_rel AS (
  SELECT DISTINCT ON (pole_id) pole_id,as_of,risk_score,risk_band,mttr_hours_365d,mtbf_hours_365d
  FROM asset_reliability_snapshots
  ORDER BY pole_id,as_of DESC
), asset_metrics AS (
  SELECT l.capital_program_id,
         COUNT(DISTINCT l.pole_id)::int AS linked_assets,
         COUNT(DISTINCT l.work_order_id)::int AS linked_work_orders,
         COUNT(DISTINCT l.work_order_id) FILTER (WHERE EXISTS (
           SELECT 1 FROM work_order_verifications v
           WHERE v.work_order_id=l.work_order_id AND v.result='PASS'
         ))::int AS verified_work_orders,
         COUNT(DISTINCT l.work_order_id) FILTER (WHERE l.work_order_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM work_order_evidence e
           WHERE e.work_order_id=l.work_order_id AND e.evidence_type='BEFORE'
         ))::int AS work_orders_with_before,
         COUNT(DISTINCT l.work_order_id) FILTER (WHERE l.work_order_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM work_order_evidence e
           WHERE e.work_order_id=l.work_order_id AND e.evidence_type='AFTER'
         ))::int AS work_orders_with_after,
         ROUND(AVG(h.health_score),2) AS current_avg_health_score,
         ROUND(AVG(100-COALESCE(r.risk_score,50)),2) AS current_avg_reliability_score,
         COALESCE(SUM(CASE WHEN wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED') THEN 1 ELSE 0 END),0)::int AS current_open_work_orders,
         COALESCE(SUM(CASE WHEN wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED') AND NOW()>wo.sla_deadline THEN 1 ELSE 0 END),0)::int AS current_sla_exposure
  FROM links l
  LEFT JOIN latest_health h ON h.pole_id=l.pole_id
  LEFT JOIN latest_rel r ON r.pole_id=l.pole_id
  LEFT JOIN work_orders wo ON wo.work_order_id=l.work_order_id
  GROUP BY l.capital_program_id
)
SELECT cp.capital_program_id,cp.program_key,cp.title,cp.zone_id,
       COALESCE(m.linked_assets,0) AS linked_assets,
       COALESCE(m.linked_work_orders,0) AS linked_work_orders,
       COALESCE(m.verified_work_orders,0) AS verified_work_orders,
       COALESCE(m.work_orders_with_before,0) AS work_orders_with_before,
       COALESCE(m.work_orders_with_after,0) AS work_orders_with_after,
       COALESCE(m.current_avg_health_score,0) AS current_avg_health_score,
       COALESCE(m.current_avg_reliability_score,0) AS current_avg_reliability_score,
       COALESCE(m.current_open_work_orders,0) AS current_open_work_orders,
       COALESCE(m.current_sla_exposure,0) AS current_sla_exposure,
       CASE WHEN COALESCE(m.linked_assets,0)=0 THEN 'NO_LINKED_ASSETS'
            WHEN COALESCE(m.linked_work_orders,0)=0 THEN 'EXECUTION_INCOMPLETE'
            WHEN COALESCE(m.verified_work_orders,0)=COALESCE(m.linked_work_orders,0) THEN 'EXECUTION_VERIFIED'
            ELSE 'EXECUTION_MIXED' END AS execution_evidence_state
FROM municipal_capital_programs cp
LEFT JOIN asset_metrics m ON m.capital_program_id=cp.capital_program_id;

CREATE OR REPLACE FUNCTION prevent_capital_program_outcome_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Capital program outcome assessments are append-only' USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_capital_program_outcome_append_only
  ON municipal_capital_program_outcome_assessments;
CREATE TRIGGER trg_capital_program_outcome_append_only
BEFORE UPDATE OR DELETE ON municipal_capital_program_outcome_assessments
FOR EACH ROW EXECUTE FUNCTION prevent_capital_program_outcome_mutation();

CREATE INDEX IF NOT EXISTS idx_capital_program_outcome_execution_state
  ON municipal_capital_program_outcome_assessments(capital_program_id,execution_evidence_state,measured_at DESC);

COMMIT;
