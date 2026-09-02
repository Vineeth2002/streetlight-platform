-- 053_program_portfolio_linkage.sql
-- Connects human-created municipal programs to advisory portfolio intelligence.
-- This is traceability only: portfolio intelligence never creates or executes programs.

ALTER TABLE municipal_programs
  ADD COLUMN IF NOT EXISTS source_type VARCHAR(20) NOT NULL DEFAULT 'MANUAL'
    CHECK (source_type IN ('MANUAL','PORTFOLIO')),
  ADD COLUMN IF NOT EXISTS portfolio_program_type VARCHAR(80),
  ADD COLUMN IF NOT EXISTS portfolio_zone_id INT REFERENCES zones(zone_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS portfolio_cluster_type VARCHAR(30),
  ADD COLUMN IF NOT EXISTS portfolio_cluster_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS registration_notes TEXT;

ALTER TABLE municipal_programs
  DROP CONSTRAINT IF EXISTS municipal_programs_portfolio_link_check;

ALTER TABLE municipal_programs
  ADD CONSTRAINT municipal_programs_portfolio_link_check CHECK (
    (source_type='MANUAL' AND portfolio_program_type IS NULL AND portfolio_zone_id IS NULL
      AND portfolio_cluster_type IS NULL AND portfolio_cluster_key IS NULL)
    OR
    (source_type='PORTFOLIO' AND portfolio_program_type IS NOT NULL AND portfolio_zone_id IS NOT NULL
      AND portfolio_cluster_type IS NOT NULL AND portfolio_cluster_key IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_municipal_programs_portfolio_link
  ON municipal_programs(portfolio_program_type, portfolio_zone_id, portfolio_cluster_type, portfolio_cluster_key);

CREATE OR REPLACE VIEW v_municipal_program_lifecycle AS
SELECT p.program_id,p.program_type,p.program_key,p.zone_id,p.title,p.objective,
       p.owner_user_id,p.status,p.priority_score,p.planned_start_date,p.target_end_date,
       p.actual_end_date,p.decision_notes,p.metadata,p.source_type,
       p.portfolio_program_type,p.portfolio_zone_id,p.portfolio_cluster_type,p.portfolio_cluster_key,
       p.registration_notes,p.created_at,p.updated_at,
       COALESCE(e.event_count,0)::int AS event_count,
       e.last_event_at,
       e.last_event_status,
       CASE
         WHEN p.status IN ('PROPOSED','UNDER_REVIEW') THEN 'DECISION_PENDING'
         WHEN p.status='APPROVED' THEN 'READY_FOR_CONTROLLED_EXECUTION'
         WHEN p.status IN ('ACTIVE','MONITORED') THEN 'OUTCOME_MONITORING'
         WHEN p.status='COMPLETED' THEN 'CLOSED_FOR_EXECUTION'
         WHEN p.status='PAUSED' THEN 'MANAGEMENT_REVIEW_REQUIRED'
         WHEN p.status='REJECTED' THEN 'CLOSED_WITHOUT_EXECUTION'
         ELSE 'REVIEW'
       END AS governance_state
FROM municipal_programs p
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS event_count,MAX(changed_at) AS last_event_at,
         (ARRAY_AGG(to_status ORDER BY changed_at DESC))[1] AS last_event_status
  FROM municipal_program_events pe
  WHERE pe.program_id=p.program_id
) e ON TRUE;
