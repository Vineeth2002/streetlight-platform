-- ═══════════════════════════════════════════════════════════════════════
-- AI RECOMMENDATION LAYER — Schema for confidence-scored diagnosis,
-- human verification loop, and crisis/war-room detection.
--
-- IMPORTANT: This schema supports the FUTURE learning system.
-- Right now, confidence scores are rule-based estimates, not ML output.
-- Real learning only becomes possible once fault_feedback accumulates
-- real verified corrections from actual GVMC field engineers.
-- ═══════════════════════════════════════════════════════════════════════

-- Add recommendation fields to work_orders (non-destructive — additive only)
ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS recommended_fault   VARCHAR(60),
  ADD COLUMN IF NOT EXISTS confidence_pct      NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS possible_causes     JSONB,
  ADD COLUMN IF NOT EXISTS verified_fault      VARCHAR(60),
  ADD COLUMN IF NOT EXISTS verified_by         INT REFERENCES users(user_id),
  ADD COLUMN IF NOT EXISTS verified_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS model_version       VARCHAR(20) DEFAULT 'rule-based-v1';

COMMENT ON COLUMN work_orders.recommended_fault IS
  'What the system guessed. Never overwritten once set — verified_fault holds the human-confirmed answer separately, so we can measure accuracy over time.';
COMMENT ON COLUMN work_orders.model_version IS
  'Which diagnostic logic version produced this recommendation. Currently rule-based-v1 (threshold logic, not real ML). Lets us audit "this was a v1 guess" vs future "v2 ML guess" during accuracy reviews.';

-- ─── FAULT FEEDBACK — the "AI gold" table ─────────────────────────────────
-- Every time a human verifies or corrects a recommendation, it's logged here.
-- This table is the raw material for any future real learning system.
-- NEVER delete rows from this table — it is a historical accuracy record.
CREATE TABLE IF NOT EXISTS fault_feedback (
  feedback_id         SERIAL PRIMARY KEY,
  work_order_id       INT NOT NULL REFERENCES work_orders(work_order_id),
  recommended_fault   VARCHAR(60) NOT NULL,
  confidence_pct      NUMERIC(5,2),
  verified_fault      VARCHAR(60) NOT NULL,
  correct_prediction  BOOLEAN NOT NULL,
  model_version       VARCHAR(20) NOT NULL,
  evidence            JSONB,
  reviewed_by         INT REFERENCES users(user_id),
  reviewed_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_model    ON fault_feedback(model_version);
CREATE INDEX IF NOT EXISTS idx_feedback_correct   ON fault_feedback(correct_prediction);
CREATE INDEX IF NOT EXISTS idx_feedback_wo        ON fault_feedback(work_order_id);

COMMENT ON TABLE fault_feedback IS
  'Historical record of every fault-recommendation verification. This is what a future real ML model would train on. Do not delete rows — accuracy trends depend on the full history.';

-- ─── CRISIS / WAR ROOM DETECTION ──────────────────────────────────────────
-- A simple view, not a new table — detects zones with an unusual spike
-- of simultaneous open faults, which the frontend uses to trigger
-- "Crisis Mode" dashboard layout.
CREATE OR REPLACE VIEW v_crisis_zones AS
SELECT
  z.zone_id,
  z.zone_name,
  COUNT(wo.work_order_id) AS open_faults_last_hour,
  COUNT(wo.work_order_id) FILTER (WHERE wo.severity_hint = 'CRITICAL') AS critical_count
FROM zones z
JOIN wards w             ON w.zone_id = z.zone_id
JOIN junction_boxes jb    ON jb.ward_id = w.ward_id
JOIN poles p              ON p.cabinet_id = jb.cabinet_id
JOIN work_orders wo       ON wo.pole_id = p.pole_id
WHERE wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS')
  AND wo.reported_timestamp >= NOW() - INTERVAL '1 hour'
GROUP BY z.zone_id, z.zone_name
HAVING COUNT(wo.work_order_id) >= 5;   -- threshold: 5+ simultaneous faults = crisis

COMMENT ON VIEW v_crisis_zones IS
  'Zones with 5+ faults reported in the last hour. Frontend polls this to decide whether to show Crisis/War Room mode. Threshold is a starting estimate — tune once real fault-arrival rates are known.';

-- Add severity_hint if not already present (used by the view above)
ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS severity_hint VARCHAR(20);