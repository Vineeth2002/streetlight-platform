-- 056_strategy_policy_evidence_governance.sql
-- Makes strategic policy decisions traceable to governed program-learning evidence.
-- Advisory only: no automatic policy adoption or operational execution.

ALTER TABLE municipal_strategy_policies
  ADD COLUMN IF NOT EXISTS source_program_type VARCHAR(80),
  ADD COLUMN IF NOT EXISTS source_zone_id INT REFERENCES zones(zone_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_learning_signal VARCHAR(30),
  ADD COLUMN IF NOT EXISTS source_evidence_count INT CHECK (source_evidence_count >= 0),
  ADD COLUMN IF NOT EXISTS source_avg_benefit_score NUMERIC(6,2) CHECK (source_avg_benefit_score BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS source_effectiveness_rate NUMERIC(6,2) CHECK (source_effectiveness_rate BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS evidence_captured_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_strategy_policy_source
  ON municipal_strategy_policies(source_program_type,source_zone_id,status);

CREATE OR REPLACE VIEW v_municipal_policy_evidence AS
SELECT p.policy_id,p.policy_key,p.policy_area,p.title,p.status,p.priority_score,p.horizon_years,
       p.source_program_type,p.source_zone_id,p.source_learning_signal,
       p.source_evidence_count,p.source_avg_benefit_score,p.source_effectiveness_rate,
       p.evidence_captured_at,
       l.measured_programs AS current_measured_programs,
       l.effectiveness_rate AS current_effectiveness_rate,
       l.avg_benefit_score AS current_avg_benefit_score,
       l.learning_signal AS current_learning_signal,
       CASE
         WHEN p.source_program_type IS NULL THEN 'UNLINKED_POLICY'
         WHEN l.program_type IS NULL THEN 'SOURCE_EVIDENCE_NO_LONGER_PRESENT'
         WHEN p.source_learning_signal IS DISTINCT FROM l.learning_signal
           OR p.source_evidence_count IS DISTINCT FROM l.measured_programs
           OR p.source_effectiveness_rate IS DISTINCT FROM l.effectiveness_rate
           OR p.source_avg_benefit_score IS DISTINCT FROM l.avg_benefit_score
           THEN 'EVIDENCE_CHANGED_REVIEW_REQUIRED'
         ELSE 'EVIDENCE_CURRENT'
       END AS evidence_state
FROM municipal_strategy_policies p
LEFT JOIN v_municipal_program_learning_patterns l
  ON l.program_type=p.source_program_type
 AND l.zone_id IS NOT DISTINCT FROM p.source_zone_id;

CREATE OR REPLACE VIEW v_municipal_policy_command AS
SELECT s.*,p.policy_id,p.policy_key,p.policy_area,p.title AS policy_title,p.status AS policy_status,
       p.priority_score AS policy_priority_score,p.horizon_years,p.decision_notes AS policy_decision_notes,
       pe.evidence_state,pe.source_evidence_count,pe.source_avg_benefit_score,
       pe.source_effectiveness_rate,pe.evidence_captured_at
FROM v_municipal_strategic_planning_signals s
LEFT JOIN municipal_strategy_policies p
  ON p.policy_key = ('PROGRAM_TYPE:'||s.program_type||':ZONE:'||COALESCE(s.zone_id::text,'CITY'))
LEFT JOIN v_municipal_policy_evidence pe ON pe.policy_id=p.policy_id;
