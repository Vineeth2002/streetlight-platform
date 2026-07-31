-- SECURITY TABLES
-- Run after 001_schema.sql, 002_triggers.sql, 003_seed.sql

CREATE TABLE IF NOT EXISTS users (
    user_id         SERIAL PRIMARY KEY,
    full_name       VARCHAR(150) NOT NULL,
    email           VARCHAR(150) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    role            VARCHAR(25) NOT NULL
                    CHECK (role IN (
                        'SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE',
                        'CONTRACTOR','FIELD_ENGINEER','READ_ONLY'
                    )),
    zone_id         INT REFERENCES zones(zone_id) ON DELETE SET NULL,
    contractor_id   INT REFERENCES contractors(contractor_id) ON DELETE SET NULL,
    is_active       BOOLEAN DEFAULT true,
    last_login      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
    log_id          SERIAL PRIMARY KEY,
    user_id         INT REFERENCES users(user_id) ON DELETE SET NULL,
    action          VARCHAR(100) NOT NULL,
    resource        VARCHAR(100),
    resource_id     INT,
    ip_address      INET,
    user_agent      TEXT,
    success         BOOLEAN DEFAULT true,
    details         JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_keys (
    key_id          SERIAL PRIMARY KEY,
    key_hash        VARCHAR(255) UNIQUE NOT NULL,
    name            VARCHAR(100) NOT NULL,
    role            VARCHAR(25) NOT NULL,
    zone_id         INT REFERENCES zones(zone_id) ON DELETE SET NULL,
    contractor_id   INT REFERENCES contractors(contractor_id) ON DELETE SET NULL,
    last_used       TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    token_id        SERIAL PRIMARY KEY,
    user_id         INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    token_hash      VARCHAR(255) UNIQUE NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS monthly_glow_snapshots (
    snapshot_id          SERIAL PRIMARY KEY,
    snapshot_month       DATE NOT NULL,
    zone_id              INT REFERENCES zones(zone_id),
    zone_name            VARCHAR(100),
    total_poles          INT DEFAULT 0,
    operational_poles    INT DEFAULT 0,
    glow_rate_pct        NUMERIC(5,2),
    contractor_id        INT REFERENCES contractors(contractor_id),
    company_name         VARCHAR(200),
    target_glow_rate     NUMERIC(5,2),
    met_target           BOOLEAN DEFAULT false,
    penalty_recommended  NUMERIC(14,2) DEFAULT 0,
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(snapshot_month, zone_id)
);

-- Triggers
CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_email          ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role           ON users(role);
CREATE INDEX IF NOT EXISTS idx_audit_user           ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created        ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refresh_user         ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_apikeys_hash         ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_glow_snapshots_month ON monthly_glow_snapshots(snapshot_month DESC);
CREATE INDEX IF NOT EXISTS idx_glow_snapshots_zone  ON monthly_glow_snapshots(zone_id);
