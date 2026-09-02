-- 017_predictive_decision_intelligence.sql
-- Adds human-controlled traceability from advisory predictive alerts to execution.
-- Predictive intelligence can recommend work; it never changes pole state autonomously.

ALTER TABLE predictive_alerts
  ADD COLUMN IF NOT EXISTS converted_work_order_id INT REFERENCES work_orders(work_order_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS converted_by INT REFERENCES users(user_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_predictive_alerts_converted_wo
  ON predictive_alerts(converted_work_order_id)
  WHERE converted_work_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_predictive_alerts_status_score
  ON predictive_alerts(status, score DESC, generated_at DESC);
