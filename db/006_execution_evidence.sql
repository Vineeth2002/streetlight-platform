-- Execution lifecycle and evidence bridge. Additive only.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='work_orders' AND column_name='incident_id'
  ) THEN
    ALTER TABLE work_orders ADD COLUMN incident_id UUID REFERENCES incidents(incident_id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_work_orders_incident ON work_orders(incident_id);

CREATE TABLE IF NOT EXISTS work_order_events (
  event_id BIGSERIAL PRIMARY KEY,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(work_order_id) ON DELETE CASCADE,
  from_status VARCHAR(30),
  to_status VARCHAR(30),
  actor_user_id INTEGER,
  event_type VARCHAR(40) NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_work_order_events_wo_time ON work_order_events(work_order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS work_order_evidence (
  evidence_id BIGSERIAL PRIMARY KEY,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(work_order_id) ON DELETE CASCADE,
  evidence_type VARCHAR(30) NOT NULL CHECK (evidence_type IN ('BEFORE','AFTER','INSPECTION','GPS','DOCUMENT')),
  file_url TEXT,
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  captured_at TIMESTAMPTZ,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_work_order_evidence_wo ON work_order_evidence(work_order_id, uploaded_at DESC);

CREATE TABLE IF NOT EXISTS work_order_verifications (
  verification_id BIGSERIAL PRIMARY KEY,
  work_order_id INTEGER NOT NULL REFERENCES work_orders(work_order_id) ON DELETE CASCADE,
  verified_by INTEGER NOT NULL,
  result VARCHAR(20) NOT NULL CHECK (result IN ('PASS','FAIL','PARTIAL')),
  notes TEXT,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_work_order_verifications_wo ON work_order_verifications(work_order_id, verified_at DESC);
