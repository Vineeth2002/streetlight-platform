-- Cabinet-level correlation. Uses the existing junction_boxes -> poles relationship.
-- This does not assume a vendor-specific circuit model.

CREATE TABLE IF NOT EXISTS incident_groups (
    group_id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_type       VARCHAR(30) NOT NULL CHECK (group_type IN ('CABINET','CIRCUIT','REGIONAL','OTHER')),
    cabinet_id       INT REFERENCES junction_boxes(cabinet_id) ON DELETE SET NULL,
    status           VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    first_detected   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_detected    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    affected_count   INT NOT NULL DEFAULT 0,
    metadata         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_incident_groups_cabinet_status
    ON incident_groups(cabinet_id, status, last_detected DESC);

ALTER TABLE incidents
    ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES incident_groups(group_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_incidents_group ON incidents(group_id);

CREATE TABLE IF NOT EXISTS incident_group_assets (
    group_id       UUID NOT NULL REFERENCES incident_groups(group_id) ON DELETE CASCADE,
    pole_id        INT NOT NULL REFERENCES poles(pole_id) ON DELETE RESTRICT,
    observed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reason         VARCHAR(80),
    PRIMARY KEY (group_id, pole_id)
);

CREATE INDEX IF NOT EXISTS idx_group_assets_pole ON incident_group_assets(pole_id, observed_at DESC);
