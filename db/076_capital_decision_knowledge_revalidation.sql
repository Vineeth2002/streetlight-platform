BEGIN;

-- Current knowledge state is derived from immutable decision history plus the latest human review.
-- A review resolution can revalidate a precedent without rewriting the original decision/evidence.
CREATE OR REPLACE VIEW v_municipal_capital_decision_knowledge_revalidation AS
SELECT q.*,
       r.resolution_id,
       r.review_state AS latest_review_state,
       r.review_notes AS latest_review_notes,
       r.evidence_captured_at AS latest_review_evidence_captured_at,
       r.resolved_at AS latest_review_resolved_at,
       CASE
         WHEN r.review_state IN ('EVIDENCE_REFRESHED','CONTEXT_CONFIRMED','RETAIN_WITH_CAUTION')
           AND r.evidence_captured_at >= NOW() - INTERVAL '180 days' THEN 'REVALIDATED'
         WHEN r.review_state='NO_LONGER_REUSABLE' THEN 'BLOCKED_FROM_REUSE'
         WHEN r.review_state='REQUIRES_MORE_EVIDENCE' THEN 'EVIDENCE_REVIEW_OPEN'
         WHEN q.evidence_freshness_state='CURRENT' THEN 'CURRENT_WITHOUT_REVIEW'
         WHEN q.evidence_freshness_state='SUPERSEDED' THEN 'SUPERSEDED'
         ELSE 'REVALIDATION_REQUIRED'
       END AS revalidation_state,
       CASE
         WHEN r.review_state IN ('EVIDENCE_REFRESHED','CONTEXT_CONFIRMED','RETAIN_WITH_CAUTION')
           AND r.evidence_captured_at >= NOW() - INTERVAL '180 days' THEN 'PRECEDENT_MAY_BE_REUSED_AFTER_CONTEXT_REVIEW'
         WHEN r.review_state='NO_LONGER_REUSABLE' THEN 'DO_NOT_REUSE_PRECEDENT'
         WHEN r.review_state='REQUIRES_MORE_EVIDENCE' THEN 'COLLECT_MORE_EVIDENCE'
         WHEN q.evidence_freshness_state='CURRENT' THEN 'CONTEXT_REVIEW_REQUIRED'
         WHEN q.evidence_freshness_state='SUPERSEDED' THEN 'DO_NOT_USE_AS_CURRENT_PRECEDENT'
         ELSE 'REFRESH_OR_REVIEW_EVIDENCE'
       END AS revalidation_guidance,
       'HUMAN_GOVERNED_KNOWLEDGE_STATE' AS decision_authority
FROM v_municipal_capital_decision_knowledge_quality q
LEFT JOIN v_municipal_capital_decision_review_resolution_latest r ON r.decision_id=q.decision_id;

CREATE OR REPLACE VIEW v_municipal_capital_decision_knowledge_revalidation_summary AS
SELECT zone_id,zone_name,selected_scenario_key,revalidation_state,
       COUNT(DISTINCT decision_id)::int AS decisions,
       COUNT(*)::int AS evidence_records
FROM v_municipal_capital_decision_knowledge_revalidation
GROUP BY zone_id,zone_name,selected_scenario_key,revalidation_state;

COMMIT;
