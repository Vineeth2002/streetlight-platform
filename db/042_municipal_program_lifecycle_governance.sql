-- 042_municipal_program_lifecycle_governance.sql
-- Governance metadata for advisory municipal programs. Lifecycle decisions are
-- human-controlled and never execute work, allocate resources, or alter operations.

CREATE TABLE IF NOT EXISTS municipal_programs (
    program_id BIGSERIAL PRIMARY KEY,
    program_type VARCHAR(80) NOT NULL,
    program_key VARCHAR(255) NOT NULL,
    zone_id INT REFERENCES zones(zone_id) ON DELETE SET NULL,
    title VARCHAR(255) NOT NULL,
    objective TEXT,
    owner_user_id INT REFERENCES users(user_id) ON DELETE SET NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'PROPOSED'
      CHECK (status IN ('PROPOSED','UNDER_REVIEW','APPROVED','ACTIVE','MONITORED','COMPLETED','PAUSED','REJECTED')),
    priority_score NUMERIC(8,2) CHECK (priority_score BETWEEN 0 AND 100),
    planned_start_date DATE,
    target_end_date DATE,
    actual_end_date DATE,
    decision_notes TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(program_type, program_key)
);

CREATE INDEX IF NOT EXISTS idx_municipal_programs_status_zone
  ON municipal_programs(status, zone_id);
CREATE INDEX IF NOT EXISTS idx_municipal_programs_owner
  ON municipal_programs(owner_user_id, status);

CREATE TABLE IF NOT EXISTS municipal_program_events (
    event_id BIGSERIAL PRIMARY KEY,
    program_id BIGINT NOT NULL REFERENCES municipal_programs(program_id) ON DELETE CASCADE,
    from_status VARCHAR(30),
    to_status VARCHAR(30) NOT NULL,
    event_type VARCHAR(40) NOT NULL DEFAULT 'STATUS_CHANGE',
    decision_notes TEXT,
    evidence_uri TEXT,
    changed_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_municipal_program_events_program
  ON municipal_program_events(program_id, changed_at DESC);

CREATE OR REPLACE FUNCTION touch_municipal_program_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_municipal_program_updated_at ON municipal_programs;
CREATE TRIGGER trg_municipal_program_updated_at
BEFORE UPDATE ON municipal_programs
FOR EACH ROW EXECUTE FUNCTION touch_municipal_program_updated_at();

CREATE OR REPLACE VIEW v_municipal_program_lifecycle AS
SELECT p.program_id,p.program_type,p.program_key,p.zone_id,p.title,p.objective,
       p.owner_user_id,p.status,p.priority_score,p.planned_start_date,p.target_end_date,
       p.actual_end_date,p.decision_notes,p.created_at,p.updated_at,
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

CREATE OR REPLACE VIEW v_municipal_program_lifecycle_summary AS
SELECT zone_id,status,governance_state,COUNT(*)::int AS programs,
       ROUND(AVG(priority_score),2) AS avg_priority_score,
       MAX(priority_score) AS max_priority_score
FROM v_municipal_program_lifecycle
GROUP BY zone_id,status,governance_state;
