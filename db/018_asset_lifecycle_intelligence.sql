-- 018_asset_lifecycle_intelligence.sql
-- Longitudinal asset history. Events are append-only and advisory; operational
-- status remains governed by the existing pole/workflow services.

CREATE TABLE IF NOT EXISTS asset_lifecycle_events (
    lifecycle_event_id      BIGSERIAL PRIMARY KEY,
    pole_id                 INT NOT NULL REFERENCES poles(pole_id) ON DELETE CASCADE,
    event_type              VARCHAR(30) NOT NULL CHECK (event_type IN (
        'INSTALLED','COMMISSIONED','MAINTENANCE','REPAIR','REPLACEMENT',
        'INSPECTION','WARRANTY','DECOMMISSIONED','RECOMMISSIONED','OTHER'
    )),
    event_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    work_order_id           INT REFERENCES work_orders(work_order_id) ON DELETE SET NULL,
    contract_id             INT REFERENCES municipal_contracts(contract_id) ON DELETE SET NULL,
    actor_id                INT REFERENCES users(user_id) ON DELETE SET NULL,
    description             TEXT,
    metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_asset_lifecycle_pole_time
    ON asset_lifecycle_events(pole_id, event_at DESC, lifecycle_event_id DESC);
CREATE INDEX IF NOT EXISTS idx_asset_lifecycle_type_time
    ON asset_lifecycle_events(event_type, event_at DESC);
CREATE INDEX IF NOT EXISTS idx_asset_lifecycle_work_order
    ON asset_lifecycle_events(work_order_id)
    WHERE work_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_asset_lifecycle_contract
    ON asset_lifecycle_events(contract_id)
    WHERE contract_id IS NOT NULL;

CREATE OR REPLACE VIEW v_asset_lifecycle_summary AS
SELECT p.pole_id,
       p.pole_number,
       p.current_status,
       p.installation_date,
       p.last_maintenance,
       COUNT(e.lifecycle_event_id)::int AS lifecycle_event_count,
       MAX(e.event_at) AS last_lifecycle_event_at,
       COUNT(*) FILTER (WHERE e.event_type IN ('REPAIR','REPLACEMENT'))::int AS repair_replacement_events,
       COUNT(*) FILTER (WHERE e.event_type='MAINTENANCE')::int AS maintenance_events,
       COUNT(*) FILTER (WHERE e.event_type='INSPECTION')::int AS inspection_events
FROM poles p
LEFT JOIN asset_lifecycle_events e ON e.pole_id=p.pole_id
GROUP BY p.pole_id,p.pole_number,p.current_status,p.installation_date,p.last_maintenance;
