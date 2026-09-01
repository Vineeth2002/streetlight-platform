-- Fault episode lifecycle: groups repeated telemetry for the same asset/fault
-- into one operational episode without changing existing SLA or percentage rules.

CREATE TABLE IF NOT EXISTS fault_episodes (
    episode_id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pole_id             INT NOT NULL REFERENCES poles(pole_id) ON DELETE RESTRICT,
    fault_category      VARCHAR(60) NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'OPEN'
                         CHECK (status IN ('OPEN','RECOVERED','CLOSED','CANCELLED')),
    first_detected_at   TIMESTAMPTZ NOT NULL,
    last_observed_at    TIMESTAMPTZ NOT NULL,
    recovered_at        TIMESTAMPTZ,
    closed_at           TIMESTAMPTZ,
    incident_id         UUID REFERENCES incidents(incident_id) ON DELETE SET NULL,
    work_order_id       INT REFERENCES work_orders(work_order_id) ON DELETE SET NULL,
    detection_source    VARCHAR(30) NOT NULL DEFAULT 'TELEMETRY',
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fault_episode_open_asset
    ON fault_episodes(pole_id, fault_category, status);
CREATE INDEX IF NOT EXISTS idx_fault_episode_time
    ON fault_episodes(first_detected_at DESC);

-- Only one active episode for the same pole/fault category.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fault_episode_active
    ON fault_episodes(pole_id, fault_category)
    WHERE status = 'OPEN';
