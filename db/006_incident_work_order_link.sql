-- Link operational incidents to the existing pole-centric work-order system.
-- Also adds diagnostic recommendation metadata required by diagnosticEngine.

ALTER TABLE work_orders
    ADD COLUMN IF NOT EXISTS incident_id UUID REFERENCES incidents(incident_id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS recommended_fault VARCHAR(60),
    ADD COLUMN IF NOT EXISTS confidence_pct NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS possible_causes JSONB,
    ADD COLUMN IF NOT EXISTS model_version VARCHAR(50),
    ADD COLUMN IF NOT EXISTS severity_hint VARCHAR(15);

CREATE INDEX IF NOT EXISTS idx_wo_incident ON work_orders(incident_id);

CREATE TABLE IF NOT EXISTS incident_work_orders (
    incident_id UUID NOT NULL REFERENCES incidents(incident_id) ON DELETE CASCADE,
    work_order_id INT NOT NULL REFERENCES work_orders(work_order_id) ON DELETE CASCADE,
    relationship VARCHAR(30) NOT NULL DEFAULT 'RESPONSE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (incident_id, work_order_id)
);

CREATE INDEX IF NOT EXISTS idx_iwo_work_order ON incident_work_orders(work_order_id);
