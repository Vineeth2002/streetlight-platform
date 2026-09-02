-- 054_program_outcome_governance_hardening.sql
-- Outcome assessments are evidence records. They may only be recorded once a
-- governed program reaches MONITORED or COMPLETED, and each assessment records
-- the lifecycle state/event that authorized the measurement.

ALTER TABLE municipal_program_outcome_assessments
  ADD COLUMN IF NOT EXISTS program_status_at_assessment VARCHAR(30),
  ADD COLUMN IF NOT EXISTS lifecycle_event_id BIGINT REFERENCES municipal_program_events(event_id) ON DELETE SET NULL;

UPDATE municipal_program_outcome_assessments po
SET program_status_at_assessment = p.status
FROM municipal_programs p
WHERE p.program_id = po.program_id
  AND po.program_status_at_assessment IS NULL;

CREATE INDEX IF NOT EXISTS idx_program_outcome_lifecycle_event
  ON municipal_program_outcome_assessments(lifecycle_event_id);

CREATE INDEX IF NOT EXISTS idx_program_outcome_program_status
  ON municipal_program_outcome_assessments(program_id,program_status_at_assessment,measured_at DESC);

CREATE OR REPLACE FUNCTION prevent_program_outcome_assessment_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'municipal_program_outcome_assessments is append-only evidence history'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_program_outcome_assessment_append_only
  ON municipal_program_outcome_assessments;
CREATE TRIGGER trg_program_outcome_assessment_append_only
BEFORE UPDATE OR DELETE ON municipal_program_outcome_assessments
FOR EACH ROW EXECUTE FUNCTION prevent_program_outcome_assessment_mutation();

COMMENT ON TABLE municipal_program_outcome_assessments IS
  'Append-only human outcome evidence for governed municipal programs.';
