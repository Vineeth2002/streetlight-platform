-- 055_program_learning_evidence_governance.sql
-- Strategy reviews must be grounded in the current governed-program outcome
-- evidence set. The review remains human-authored and advisory.

ALTER TABLE municipal_program_strategy_reviews
  ADD COLUMN IF NOT EXISTS evidence_program_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS evidence_assessment_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS evidence_snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE municipal_program_strategy_reviews
  DROP CONSTRAINT IF EXISTS chk_program_strategy_evidence_program_ids_array;
ALTER TABLE municipal_program_strategy_reviews
  ADD CONSTRAINT chk_program_strategy_evidence_program_ids_array
  CHECK (jsonb_typeof(evidence_program_ids)='array');

ALTER TABLE municipal_program_strategy_reviews
  DROP CONSTRAINT IF EXISTS chk_program_strategy_evidence_assessment_ids_array;
ALTER TABLE municipal_program_strategy_reviews
  ADD CONSTRAINT chk_program_strategy_evidence_assessment_ids_array
  CHECK (jsonb_typeof(evidence_assessment_ids)='array');

CREATE INDEX IF NOT EXISTS idx_program_strategy_reviews_evidence_snapshot
  ON municipal_program_strategy_reviews(evidence_snapshot_at DESC);

CREATE OR REPLACE FUNCTION prevent_program_strategy_review_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'municipal_program_strategy_reviews is append-only strategy evidence history'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_program_strategy_review_append_only
  ON municipal_program_strategy_reviews;
CREATE TRIGGER trg_program_strategy_review_append_only
BEFORE UPDATE OR DELETE ON municipal_program_strategy_reviews
FOR EACH ROW EXECUTE FUNCTION prevent_program_strategy_review_mutation();

COMMENT ON TABLE municipal_program_strategy_reviews IS
  'Append-only human strategy reviews with snapshots of the governed outcome evidence used for the decision.';
