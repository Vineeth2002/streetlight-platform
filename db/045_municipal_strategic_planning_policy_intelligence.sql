-- 045_municipal_strategic_planning_policy_intelligence.sql
-- Converts accumulated program learning into long-horizon planning signals.
-- Advisory only: no automatic policy, budget, procurement, work-order,
-- asset-state, SLA, penalty, or glow-rate changes.

CREATE TABLE IF NOT EXISTS municipal_strategy_policies (
    policy_id BIGSERIAL PRIMARY KEY,
    policy_key VARCHAR(120) NOT NULL UNIQUE,
    policy_area VARCHAR(80) NOT NULL,
    title VARCHAR(200) NOT NULL,
    objective TEXT,
    priority_score NUMERIC(6,2) CHECK (priority_score BETWEEN 0 AND 100),
    horizon_years INT CHECK (horizon_years BETWEEN 1 AND 20),
    status VARCHAR(30) NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','UNDER_REVIEW','ADOPTED','PAUSED','RETIRED')),
    decision_notes TEXT,
    evidence_uri TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    updated_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_strategy_policies_area_status ON municipal_strategy_policies(policy_area,status);

CREATE OR REPLACE VIEW v_municipal_strategic_planning_signals AS
WITH learning AS (
  SELECT program_type,zone_id,assessed_programs,measured_programs,delivered_programs,
         no_benefit_programs,insufficient_evidence_programs,effectiveness_rate,
         avg_benefit_score,learning_signal
  FROM v_municipal_program_learning_patterns
), portfolio AS (
  SELECT program_type,zone_id,COUNT(*)::int AS portfolio_programs,
         ROUND(AVG(program_priority_score),2) AS avg_program_priority_score
  FROM v_municipal_program_portfolio
  GROUP BY program_type,zone_id
)
SELECT l.program_type,l.zone_id,l.assessed_programs,l.measured_programs,l.delivered_programs,
       l.no_benefit_programs,l.insufficient_evidence_programs,l.effectiveness_rate,
       l.avg_benefit_score,l.learning_signal,COALESCE(p.portfolio_programs,0) AS portfolio_programs,
       p.avg_program_priority_score,
       CASE
         WHEN l.learning_signal='REVISE' THEN 'POLICY_REVIEW_REQUIRED'
         WHEN l.learning_signal='REVIEW' THEN 'STRATEGIC_REVIEW_REQUIRED'
         WHEN l.learning_signal='RETAIN' AND COALESCE(p.avg_program_priority_score,0)>=70 THEN 'SCALE_CANDIDATE'
         WHEN l.learning_signal='RETAIN' THEN 'MAINTAIN_AND_MONITOR'
         ELSE 'EVIDENCE_BUILDING_REQUIRED'
       END AS planning_signal,
       CASE
         WHEN l.learning_signal='REVISE' THEN 'Repeated weak outcomes indicate that program design or targeting should be reconsidered before further strategic expansion.'
         WHEN l.learning_signal='REVIEW' THEN 'Mixed outcome evidence warrants comparison of targeting, delivery context and benefit measurement.'
         WHEN l.learning_signal='RETAIN' AND COALESCE(p.avg_program_priority_score,0)>=70 THEN 'Strong measured outcomes combined with high portfolio priority make this a candidate for human review of strategic scaling.'
         WHEN l.learning_signal='RETAIN' THEN 'Measured outcomes support continued use, subject to ongoing monitoring and municipal priorities.'
         ELSE 'Evidence is not sufficient for a durable policy conclusion; improve measurement before strategic commitment.'
       END AS planning_rationale
FROM learning l
LEFT JOIN portfolio p ON p.program_type=l.program_type AND p.zone_id IS NOT DISTINCT FROM l.zone_id;

CREATE OR REPLACE VIEW v_municipal_strategic_planning_summary AS
SELECT planning_signal,COUNT(*)::int AS strategy_groups,
       SUM(measured_programs)::int AS measured_programs,
       SUM(delivered_programs)::int AS delivered_programs,
       ROUND(AVG(effectiveness_rate),2) AS avg_effectiveness_rate,
       ROUND(AVG(avg_benefit_score),2) AS avg_benefit_score,
       ROUND(AVG(avg_program_priority_score),2) AS avg_portfolio_priority
FROM v_municipal_strategic_planning_signals
GROUP BY planning_signal;

CREATE OR REPLACE VIEW v_municipal_policy_command AS
SELECT s.*,p.policy_id,p.policy_key,p.policy_area,p.title AS policy_title,p.status AS policy_status,
       p.priority_score AS policy_priority_score,p.horizon_years,p.decision_notes AS policy_decision_notes
FROM v_municipal_strategic_planning_signals s
LEFT JOIN municipal_strategy_policies p
  ON p.policy_key = ('PROGRAM_TYPE:'||s.program_type||':ZONE:'||COALESCE(s.zone_id::text,'CITY'));
