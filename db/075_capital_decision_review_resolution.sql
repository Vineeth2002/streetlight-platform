BEGIN;

-- Append-only human resolution records for capital decision knowledge review.
-- Resolution never mutates the underlying decision or historical evidence.
CREATE TABLE IF NOT EXISTS municipal_capital_decision_review_resolutions (
  resolution_id BIGSERIAL PRIMARY KEY,
  decision_id BIGINT NOT NULL REFERENCES municipal_capital_portfolio_decisions(decision_id) ON DELETE RESTRICT,
  review_state TEXT NOT NULL CHECK (review_state IN ('EVIDENCE_REFRESHED','CONTEXT_CONFIRMED','REQUIRES_MORE_EVIDENCE','RETAIN_WITH_CAUTION','NO_LONGER_REUSABLE')),
  review_notes TEXT NOT NULL,
  evidence_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_by INT REFERENCES users(user_id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_capital_decision_review_resolution_decision
  ON municipal_capital_decision_review_resolutions(decision_id,resolved_at DESC);
CREATE INDEX IF NOT EXISTS idx_capital_decision_review_resolution_state
  ON municipal_capital_decision_review_resolutions(review_state,resolved_at DESC);

CREATE OR REPLACE FUNCTION prevent_capital_decision_review_resolution_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Capital decision review resolutions are append-only' USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_capital_decision_review_resolution_append_only ON municipal_capital_decision_review_resolutions;
CREATE TRIGGER trg_capital_decision_review_resolution_append_only
BEFORE UPDATE OR DELETE ON municipal_capital_decision_review_resolutions
FOR EACH ROW EXECUTE FUNCTION prevent_capital_decision_review_resolution_mutation();

CREATE OR REPLACE VIEW v_municipal_capital_decision_review_resolution AS
SELECT r.resolution_id,r.decision_id,d.zone_id,z.zone_name,
       d.decision_title,d.selected_scenario_key,d.decision_state,
       r.review_state,r.review_notes,r.evidence_snapshot,r.evidence_captured_at,
       r.resolved_by,r.resolved_at,r.created_at,
       CASE
         WHEN r.review_state='EVIDENCE_REFRESHED' THEN 'REVIEW_CLOSED_AFTER_EVIDENCE_REFRESH'
         WHEN r.review_state='CONTEXT_CONFIRMED' THEN 'REVIEW_CLOSED_WITH_CONTEXT_CONFIRMATION'
         WHEN r.review_state='REQUIRES_MORE_EVIDENCE' THEN 'REVIEW_REMAINS_OPEN_FOR_EVIDENCE'
         WHEN r.review_state='RETAIN_WITH_CAUTION' THEN 'PRECEDENT_RETAINED_WITH_CAUTION'
         WHEN r.review_state='NO_LONGER_REUSABLE' THEN 'PRECEDENT_BLOCKED_FROM_REUSE'
       END AS resolution_outcome,
       'HUMAN_REVIEW_ONLY' AS decision_authority
FROM municipal_capital_decision_review_resolutions r
JOIN municipal_capital_portfolio_decisions d ON d.decision_id=r.decision_id
LEFT JOIN zones z ON z.zone_id=d.zone_id;

CREATE OR REPLACE VIEW v_municipal_capital_decision_review_resolution_latest AS
SELECT *
FROM (
  SELECT v.*,ROW_NUMBER() OVER (PARTITION BY decision_id ORDER BY resolved_at DESC,resolution_id DESC) AS rn
  FROM v_municipal_capital_decision_review_resolution v
) x
WHERE rn=1;

COMMIT;
