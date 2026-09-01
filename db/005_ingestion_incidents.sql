-- Real-time ingestion and incident correlation layer.
-- Safe to run after the existing schema. No existing table is replaced.

CREATE TABLE IF NOT EXISTS ingestion_events (
    event_id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_type          VARCHAR(30) NOT NULL,
    source              VARCHAR(30) NOT NULL,
    source_device_id    VARCHAR(100),
    asset_id            INT REFERENCES poles(pole_id) ON DELETE SET NULL,
    observed_at         TIMESTAMPTZ NOT NULL,
    received_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    data                JSONB NOT NULL DEFAULT '{}'::jsonb,
    quality             JSONB NOT NULL DEFAULT '{}'::jsonb,
    correlation_id      UUID,
    processing_status   VARCHAR(20) NOT NULL DEFAULT 'PROCESSED',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingestion_asset_time
    ON ingestion_events(asset_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingestion_source_time
    ON ingestion_events(source, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingestion_correlation
    ON ingestion_events(correlation_id);

CREATE TABLE IF NOT EXISTS incidents (
    incident_id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    incident_number     VARCHAR(40) UNIQUE NOT NULL,
    incident_type       VARCHAR(40) NOT NULL,
    severity             VARCHAR(15) NOT NULL DEFAULT 'MEDIUM'
                           CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
    status               VARCHAR(25) NOT NULL DEFAULT 'OPEN'
                           CHECK (status IN ('OPEN','ACKNOWLEDGED','ASSIGNED','IN_PROGRESS','AWAITING_VERIFICATION','RESOLVED','CLOSED','CANCELLED')),
    source              VARCHAR(30) NOT NULL,
    primary_asset_id    INT REFERENCES poles(pole_id) ON DELETE SET NULL,
    detected_at         TIMESTAMPTZ NOT NULL,
    acknowledged_at     TIMESTAMPTZ,
    resolved_at         TIMESTAMPTZ,
    closed_at            TIMESTAMPTZ,
    summary             TEXT NOT NULL,
    recommendation      TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incidents_status_time
    ON incidents(status, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_asset
    ON incidents(primary_asset_id, detected_at DESC);

CREATE TABLE IF NOT EXISTS incident_assets (
    incident_id         UUID NOT NULL REFERENCES incidents(incident_id) ON DELETE CASCADE,
    pole_id             INT NOT NULL REFERENCES poles(pole_id) ON DELETE RESTRICT,
    relationship        VARCHAR(30) NOT NULL DEFAULT 'AFFECTED',
    first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (incident_id, pole_id)
);

CREATE INDEX IF NOT EXISTS idx_incident_assets_pole
    ON incident_assets(pole_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS incident_events (
    incident_id         UUID NOT NULL REFERENCES incidents(incident_id) ON DELETE CASCADE,
    event_id            UUID NOT NULL REFERENCES ingestion_events(event_id) ON DELETE RESTRICT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (incident_id, event_id)
);

-- Append this migration to the existing migration runner explicitly when ready.
