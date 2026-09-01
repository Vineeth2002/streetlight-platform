-- 013_asset_intelligence.sql
-- Durable intelligence primitives. These tables are advisory/read-model data;
-- they never redefine poles.current_status, SLA rules, or glow-rate formulas.

CREATE TABLE IF NOT EXISTS asset_reliability_snapshots (
    snapshot_id             BIGSERIAL PRIMARY KEY,
    pole_id                 INT NOT NULL REFERENCES poles(pole_id) ON DELETE CASCADE,
    as_of                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    repair_count_90d        INT NOT NULL DEFAULT 0,
    repair_count_365d       INT NOT NULL DEFAULT 0,
    recurrence_count_90d    INT NOT NULL DEFAULT 0,
    mttr_hours_365d         NUMERIC(12,2),
    mtbf_hours_365d         NUMERIC(14,2),
    days_since_last_repair  NUMERIC(12,2),
    last_failure_at         TIMESTAMPTZ,
    dominant_fault_category VARCHAR(60),
    risk_score              NUMERIC(6,2) CHECK (risk_score BETWEEN 0 AND 100),
    risk_band               VARCHAR(12) CHECK (risk_band IN ('LOW','MEDIUM','HIGH','CRITICAL')),
    factors                 JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_asset_rel_pole_asof
    ON asset_reliability_snapshots(pole_id, as_of DESC);
CREATE INDEX IF NOT EXISTS idx_asset_rel_band
    ON asset_reliability_snapshots(risk_band, as_of DESC);

CREATE TABLE IF NOT EXISTS municipal_contracts (
    contract_id             SERIAL PRIMARY KEY,
    contractor_id           INT NOT NULL REFERENCES contractors(contractor_id) ON DELETE RESTRICT,
    contract_number         VARCHAR(80) NOT NULL UNIQUE,
    title                   VARCHAR(255) NOT NULL,
    scope                   TEXT,
    start_date              DATE,
    end_date                DATE,
    contract_value_inr      NUMERIC(16,2) CHECK (contract_value_inr >= 0),
    warranty_days           INT CHECK (warranty_days >= 0),
    status                  VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                            CHECK (status IN ('DRAFT','ACTIVE','EXPIRED','TERMINATED','CLOSED')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contracts_contractor_dates
    ON municipal_contracts(contractor_id, start_date, end_date);

CREATE TABLE IF NOT EXISTS contract_segments (
    segment_id              SERIAL PRIMARY KEY,
    contract_id             INT NOT NULL REFERENCES municipal_contracts(contract_id) ON DELETE CASCADE,
    zone_id                 INT REFERENCES zones(zone_id) ON DELETE SET NULL,
    ward_id                 INT REFERENCES wards(ward_id) ON DELETE SET NULL,
    segment_name            VARCHAR(255) NOT NULL,
    geometry                GEOMETRY(Geometry, 4326),
    target_asset_count      INT CHECK (target_asset_count >= 0),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contract_segments_geo
    ON contract_segments USING GIST(geometry);
CREATE INDEX IF NOT EXISTS idx_contract_segments_contract
    ON contract_segments(contract_id);

CREATE TABLE IF NOT EXISTS procurement_records (
    procurement_id          SERIAL PRIMARY KEY,
    contract_id             INT REFERENCES municipal_contracts(contract_id) ON DELETE SET NULL,
    tender_number           VARCHAR(80) UNIQUE,
    procurement_method      VARCHAR(40),
    notice_date             DATE,
    award_date              DATE,
    estimated_value_inr     NUMERIC(16,2) CHECK (estimated_value_inr >= 0),
    awarded_value_inr       NUMERIC(16,2) CHECK (awarded_value_inr >= 0),
    status                   VARCHAR(20) NOT NULL DEFAULT 'PLANNED'
                             CHECK (status IN ('PLANNED','TENDERED','EVALUATION','AWARDED','CANCELLED','CLOSED')),
    metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_procurement_status_date
    ON procurement_records(status, award_date DESC);

CREATE TABLE IF NOT EXISTS predictive_alerts (
    alert_id                BIGSERIAL PRIMARY KEY,
    pole_id                 INT REFERENCES poles(pole_id) ON DELETE CASCADE,
    alert_type              VARCHAR(50) NOT NULL,
    severity                VARCHAR(12) NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
    status                  VARCHAR(15) NOT NULL DEFAULT 'OPEN'
                             CHECK (status IN ('OPEN','ACKNOWLEDGED','DISMISSED','CONVERTED')),
    score                   NUMERIC(6,2) CHECK (score BETWEEN 0 AND 100),
    reason                  TEXT NOT NULL,
    evidence                JSONB NOT NULL DEFAULT '{}'::jsonb,
    generated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acknowledged_at        TIMESTAMPTZ,
    acknowledged_by        INT REFERENCES users(user_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_predictive_alerts_open
    ON predictive_alerts(status, severity, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_predictive_alerts_pole
    ON predictive_alerts(pole_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS municipal_knowledge_items (
    knowledge_id            BIGSERIAL PRIMARY KEY,
    title                   VARCHAR(255) NOT NULL,
    category                VARCHAR(60) NOT NULL,
    body                    TEXT NOT NULL,
    source_reference        VARCHAR(500),
    effective_from          DATE,
    effective_to            DATE,
    version                 VARCHAR(40),
    status                  VARCHAR(15) NOT NULL DEFAULT 'ACTIVE'
                             CHECK (status IN ('DRAFT','ACTIVE','ARCHIVED')),
    metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by              INT REFERENCES users(user_id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_category_status
    ON municipal_knowledge_items(category, status);

CREATE TABLE IF NOT EXISTS intelligence_snapshots (
    snapshot_id             BIGSERIAL PRIMARY KEY,
    snapshot_type           VARCHAR(50) NOT NULL,
    snapshot_date            DATE NOT NULL,
    payload                  JSONB NOT NULL,
    generated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(snapshot_type, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_intelligence_snapshot_type_date
    ON intelligence_snapshots(snapshot_type, snapshot_date DESC);

-- Composite indexes required by reliability and lifecycle queries at the target scale.
CREATE INDEX IF NOT EXISTS idx_wo_pole_reported
    ON work_orders(pole_id, reported_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_wo_pole_status
    ON work_orders(pole_id, ticket_status);
