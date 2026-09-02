BEGIN;

-- Feeds human-revalidated decision knowledge into scenario guidance.
-- This never selects, funds, or executes a scenario automatically.
CREATE OR REPLACE VIEW v_municipal_capital_decision_revalidated_scenario_guidance AS
WITH knowledge AS (
  SELECT decision_id,zone_id,zone_name,selected_scenario_key,
         revalidation_state,revalidation_guidance,latest_review_state,
         latest_review_resolved_at
  FROM v_municipal_capital_decision_knowledge_revalidation
), scenarios AS (
  SELECT zone_id,zone_name,scenario_key,scenario_label,
         baseline_review_score,projected_review_score,score_change,
         allocation_priority_score,scenario_state
  FROM v_municipal_capital_portfolio_scenarios
), grouped AS (
  SELECT zone_id,zone_name,selected_scenario_key,
         COUNT(DISTINCT decision_id)::int AS reviewed_decisions,
         COUNT(DISTINCT decision_id) FILTER (WHERE revalidation_state='REVALIDATED')::int AS revalidated_decisions,
         COUNT(DISTINCT decision_id) FILTER (WHERE revalidation_state='BLOCKED_FROM_REUSE')::int AS blocked_decisions,
         COUNT(DISTINCT decision_id) FILTER (WHERE revalidation_state='EVIDENCE_REVIEW_OPEN')::int AS evidence_review_open,
         MAX(latest_review_resolved_at) AS latest_review_resolved_at,
         STRING_AGG(DISTINCT revalidation_state, ', ' ORDER BY revalidation_state) AS revalidation_states
  FROM knowledge
  GROUP BY zone_id,zone_name,selected_scenario_key
)
SELECT
  s.zone_id,s.zone_name,s.scenario_key,s.scenario_label,
  s.baseline_review_score,s.projected_review_score,s.score_change,
  s.allocation_priority_score,s.scenario_state,
  COALESCE(g.reviewed_decisions,0) AS reviewed_decisions,
  COALESCE(g.revalidated_decisions,0) AS revalidated_decisions,
  COALESCE(g.blocked_decisions,0) AS blocked_decisions,
  COALESCE(g.evidence_review_open,0) AS evidence_review_open,
  g.latest_review_resolved_at,g.revalidation_states,
  CASE
    WHEN COALESCE(g.blocked_decisions,0)>0 AND COALESCE(g.revalidated_decisions,0)=0 THEN 'BLOCKED_BY_REVIEW'
    WHEN COALESCE(g.evidence_review_open,0)>0 AND COALESCE(g.revalidated_decisions,0)=0 THEN 'EVIDENCE_REVIEW_REQUIRED'
    WHEN COALESCE(g.revalidated_decisions,0)>0 THEN 'REVALIDATED_WITH_HUMAN_EVIDENCE'
    WHEN g.reviewed_decisions IS NULL THEN 'NO_REVALIDATED_DECISION_EVIDENCE'
    ELSE 'CONTEXT_REVIEW_REQUIRED'
  END AS guidance_state,
  CASE
    WHEN COALESCE(g.blocked_decisions,0)>0 AND COALESCE(g.revalidated_decisions,0)=0 THEN 'DO_NOT_REUSE_BLOCKED_PRECEDENTS'
    WHEN COALESCE(g.evidence_review_open,0)>0 AND COALESCE(g.revalidated_decisions,0)=0 THEN 'COLLECT_MORE_EVIDENCE_BEFORE_REUSE'
    WHEN COALESCE(g.revalidated_decisions,0)>0 THEN 'CONSIDER_REUSE_AFTER_LOCAL_CONTEXT_REVIEW'
    ELSE 'REVIEW_LOCAL_CONTEXT_AND_SOURCE_EVIDENCE'
  END AS recommended_review,
  'HUMAN_REVIEW_REQUIRED' AS decision_authority,
  'NO_AUTOMATIC_SCENARIO_SELECTION' AS governance_constraint
FROM scenarios s
LEFT JOIN grouped g
  ON g.zone_id IS NOT DISTINCT FROM s.zone_id
 AND g.selected_scenario_key=s.scenario_key;

CREATE OR REPLACE VIEW v_municipal_capital_decision_revalidated_scenario_summary AS
SELECT zone_id,zone_name,scenario_key,guidance_state,
       COUNT(*)::int AS scenario_records,
       SUM(revalidated_decisions)::int AS revalidated_decisions,
       SUM(blocked_decisions)::int AS blocked_decisions,
       SUM(evidence_review_open)::int AS evidence_review_open
FROM v_municipal_capital_decision_revalidated_scenario_guidance
GROUP BY zone_id,zone_name,scenario_key,guidance_state;

COMMIT;
