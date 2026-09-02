BEGIN;

-- Human review queue derived from evidence quality. This view never mutates decisions.
CREATE OR REPLACE VIEW v_municipal_capital_decision_review_queue AS
SELECT
  q.*,
  CASE
    WHEN q.evidence_freshness_state='EVIDENCE_GAP' THEN 'HIGH'
    WHEN q.evidence_freshness_state='STALE_REVIEW_REQUIRED' THEN 'HIGH'
    WHEN q.evidence_freshness_state='SUPERSEDED' THEN 'MEDIUM'
    WHEN q.evidence_freshness_state='REVIEW_REQUIRED' THEN 'MEDIUM'
    ELSE 'ROUTINE'
  END AS review_priority,
  CASE
    WHEN q.evidence_freshness_state='EVIDENCE_GAP' THEN 'CAPTURE_MISSING_OUTCOME_EVIDENCE'
    WHEN q.evidence_freshness_state='STALE_REVIEW_REQUIRED' THEN 'REFRESH_DECISION_OUTCOME_EVIDENCE'
    WHEN q.evidence_freshness_state='SUPERSEDED' THEN 'CONFIRM_REPLACEMENT_DECISION_CONTEXT'
    WHEN q.evidence_freshness_state='REVIEW_REQUIRED' THEN 'REVIEW_SOURCE_EVIDENCE'
    ELSE 'PERIODIC_CONTEXT_REVIEW'
  END AS review_action,
  'NO_AUTOMATIC_DECISION_ACTION' AS governance_constraint
FROM v_municipal_capital_decision_knowledge_quality q
WHERE q.evidence_freshness_state <> 'CURRENT';

CREATE OR REPLACE VIEW v_municipal_capital_decision_review_queue_summary AS
SELECT
  zone_id, zone_name, review_priority, evidence_freshness_state,
  COUNT(DISTINCT decision_id)::int AS decisions,
  COUNT(*)::int AS evidence_records
FROM v_municipal_capital_decision_review_queue
GROUP BY zone_id, zone_name, review_priority, evidence_freshness_state;

COMMIT;
