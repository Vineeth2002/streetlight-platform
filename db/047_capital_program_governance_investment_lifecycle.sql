BEGIN;

CREATE TABLE IF NOT EXISTS municipal_capital_programs (
  capital_program_id BIGSERIAL PRIMARY KEY,
  plan_id BIGINT REFERENCES municipal_capital_plans(plan_id) ON DELETE SET NULL,
  program_id BIGINT REFERENCES municipal_programs(program_id) ON DELETE SET NULL,
  zone_id INT REFERENCES zones(zone_id) ON DELETE SET NULL,
  program_key VARCHAR(140) NOT NULL UNIQUE,
  title TEXT NOT NULL,
  investment_theme VARCHAR(80) NOT NULL,
  proposed_amount_inr NUMERIC(18,2) NOT NULL CHECK (proposed_amount_inr >= 0),
  approved_amount_inr NUMERIC(18,2) CHECK (approved_amount_inr >= 0),
  status VARCHAR(30) NOT NULL DEFAULT 'PROPOSED'
    CHECK (status IN ('PROPOSED','UNDER_REVIEW','APPROVED','FUNDED','IN_EXECUTION','MONITORED','COMPLETED','PAUSED','REJECTED')),
  rationale TEXT,
  decision_notes TEXT,
  evidence_uri TEXT,
  owner_user_id INT REFERENCES users(user_id) ON DELETE SET NULL,
  created_by INT REFERENCES users(user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_capital_programs_zone_status ON municipal_capital_programs(zone_id,status);
CREATE INDEX IF NOT EXISTS idx_capital_programs_plan ON municipal_capital_programs(plan_id);
CREATE INDEX IF NOT EXISTS idx_capital_programs_program ON municipal_capital_programs(program_id);

CREATE TABLE IF NOT EXISTS municipal_capital_program_events (
  event_id BIGSERIAL PRIMARY KEY,
  capital_program_id BIGINT NOT NULL REFERENCES municipal_capital_programs(capital_program_id) ON DELETE CASCADE,
  from_status VARCHAR(30),
  to_status VARCHAR(30) NOT NULL,
  event_type VARCHAR(40) NOT NULL DEFAULT 'STATUS_CHANGE',
  decision_notes TEXT,
  evidence_uri TEXT,
  changed_by INT REFERENCES users(user_id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_capital_program_events_program_time ON municipal_capital_program_events(capital_program_id,changed_at DESC);

CREATE OR REPLACE FUNCTION touch_municipal_capital_program_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at=NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_municipal_capital_program_updated_at ON municipal_capital_programs;
CREATE TRIGGER trg_municipal_capital_program_updated_at BEFORE UPDATE ON municipal_capital_programs FOR EACH ROW EXECUTE FUNCTION touch_municipal_capital_program_updated_at();

CREATE OR REPLACE VIEW v_municipal_capital_program_governance AS
SELECT cp.*,z.zone_name,
       COUNT(e.event_id)::int AS event_count,
       MAX(e.changed_at) AS last_event_at,
       CASE
         WHEN cp.status IN ('PROPOSED','UNDER_REVIEW') THEN 'DECISION_PENDING'
         WHEN cp.status IN ('APPROVED','FUNDED') THEN 'FUNDING_CONTROL'
         WHEN cp.status IN ('IN_EXECUTION','MONITORED') THEN 'INVESTMENT_MONITORING'
         WHEN cp.status='COMPLETED' THEN 'CLOSED_FOR_INVESTMENT'
         WHEN cp.status='PAUSED' THEN 'MANAGEMENT_REVIEW_REQUIRED'
         WHEN cp.status='REJECTED' THEN 'CLOSED_WITHOUT_INVESTMENT'
       END AS governance_state
FROM municipal_capital_programs cp
LEFT JOIN zones z ON z.zone_id=cp.zone_id
LEFT JOIN municipal_capital_program_events e ON e.capital_program_id=cp.capital_program_id
GROUP BY cp.capital_program_id,z.zone_name;

CREATE OR REPLACE VIEW v_municipal_capital_program_summary AS
SELECT status,governance_state,COUNT(*)::int AS program_count,
       COALESCE(SUM(proposed_amount_inr),0) AS proposed_amount_inr,
       COALESCE(SUM(approved_amount_inr),0) AS approved_amount_inr,
       ROUND(AVG(priority_score),2) AS avg_priority_score
FROM v_municipal_capital_program_governance cp
LEFT JOIN municipal_capital_plans p ON p.plan_id=cp.plan_id
GROUP BY status,governance_state;

COMMIT;
