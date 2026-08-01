-- NOTE: Security tables (users, audit_log, api_keys, refresh_tokens)
-- and monthly_glow_snapshots are in db/004_security.sql
-- Run 004_security.sql after this file.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS zones (
    zone_id             SERIAL PRIMARY KEY,
    zone_name           VARCHAR(100) NOT NULL UNIQUE,
    zonal_commissioner  VARCHAR(150),
    total_poles         INT DEFAULT 0,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wards (
    ward_id                 SERIAL PRIMARY KEY,
    zone_id                 INT NOT NULL REFERENCES zones(zone_id) ON DELETE RESTRICT,
    ward_number             INT NOT NULL,
    secretariat_code        VARCHAR(20) UNIQUE NOT NULL,
    ward_amenity_sec_name   VARCHAR(150),
    ward_amenity_sec_phone  VARCHAR(15),
    total_poles             INT DEFAULT 0,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (zone_id, ward_number)
);

CREATE TABLE IF NOT EXISTS contractors (
    contractor_id           SERIAL PRIMARY KEY,
    company_name            VARCHAR(200) NOT NULL,
    assigned_zone_id        INT REFERENCES zones(zone_id) ON DELETE SET NULL,
    contact_person          VARCHAR(150),
    contact_phone           VARCHAR(15),
    contract_start_date     DATE,
    contract_end_date       DATE,
    target_glow_rate        NUMERIC(5,2) NOT NULL DEFAULT 98.00
                                CHECK (target_glow_rate BETWEEN 80.00 AND 100.00),
    active_crews_deployed   INT DEFAULT 0,
    total_solved_daily      INT DEFAULT 0,
    total_pending           INT DEFAULT 0,
    monthly_invoice_base    NUMERIC(14,2) DEFAULT 0,
    total_penalty_mtd       NUMERIC(14,2) DEFAULT 0,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS junction_boxes (
    cabinet_id              SERIAL PRIMARY KEY,
    ward_id                 INT NOT NULL REFERENCES wards(ward_id) ON DELETE RESTRICT,
    cabinet_serial_no       VARCHAR(50) UNIQUE NOT NULL,
    nominal_voltage         NUMERIC(6,2) NOT NULL DEFAULT 230.00,
    rated_capacity_kva      NUMERIC(8,2),
    installation_location   GEOMETRY(Point, 4326) NOT NULL,
    address_landmark        VARCHAR(255),
    contactor_status        VARCHAR(10) DEFAULT 'OFF'
                                CHECK (contactor_status IN ('ON','OFF','FAULT','MANUAL')),
    last_heartbeat          TIMESTAMPTZ,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS poles (
    pole_id             SERIAL PRIMARY KEY,
    pole_number         VARCHAR(30) UNIQUE NOT NULL,
    cabinet_id          INT NOT NULL REFERENCES junction_boxes(cabinet_id) ON DELETE RESTRICT,
    wiring_type         VARCHAR(12) NOT NULL
                            CHECK (wiring_type IN ('OVERHEAD','UNDERGROUND')),
    luminaire_wattage   INT NOT NULL
                            CHECK (luminaire_wattage IN (20,40,70,110,120,150)),
    node_id             VARCHAR(50) UNIQUE,
    geolocation         GEOMETRY(Point, 4326) NOT NULL,
    road_name           VARCHAR(200),
    installation_date   DATE,
    last_maintenance    DATE,
    current_status      VARCHAR(20) DEFAULT 'OPERATIONAL'
                            CHECK (current_status IN (
                                'OPERATIONAL','FAULTY','UNDER_REPAIR',
                                'DECOMMISSIONED','DAY_BURN','NO_SIGNAL'
                            )),
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS work_orders (
    work_order_id       SERIAL PRIMARY KEY,
    pole_id             INT NOT NULL REFERENCES poles(pole_id) ON DELETE RESTRICT,
    contractor_id       INT REFERENCES contractors(contractor_id) ON DELETE SET NULL,
    fault_category      VARCHAR(60) NOT NULL
                            CHECK (fault_category IN (
                                'DRIVER_FAULT','LINE_FAULT','DAY_BURNING_FAULT',
                                'PREDICTIVE_DEGRADATION','PHYSICAL_DAMAGE',
                                'CABLE_THEFT','CABINET_FAULT','MANUAL_REPORT'
                            )),
    fault_description   TEXT,
    reported_by         VARCHAR(100),
    reported_timestamp  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    assigned_timestamp  TIMESTAMPTZ,
    resolved_timestamp  TIMESTAMPTZ,
    sla_deadline        TIMESTAMPTZ,
    ticket_status       VARCHAR(15) DEFAULT 'PENDING'
                            CHECK (ticket_status IN (
                                'PENDING','ASSIGNED','IN_PROGRESS',
                                'RESOLVED','SLA_VIOLATED','CANCELLED'
                            )),
    resolution_notes    TEXT,
    penalty_deducted    NUMERIC(12,2) DEFAULT 0.00,
    penalty_type        VARCHAR(10) CHECK (penalty_type IN ('ENERGY','DEMURRAGE',NULL)),
    days_overdue        INT DEFAULT 0,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS node_telemetry (
    timestamp       TIMESTAMPTZ     NOT NULL,
    pole_number     VARCHAR(30)     NOT NULL,
    node_id         VARCHAR(50),
    voltage_rms     NUMERIC(7,3),
    current_rms     NUMERIC(7,4),
    active_power    NUMERIC(8,3),
    power_factor    NUMERIC(4,3),
    temperature     NUMERIC(5,2),
    rssi            INT,
    raw_packet_id   UUID DEFAULT uuid_generate_v4()
);

SELECT create_hypertable('node_telemetry','timestamp',chunk_time_interval => INTERVAL '1 day',if_not_exists => TRUE);

ALTER TABLE node_telemetry SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'pole_number',
    timescaledb.compress_orderby   = 'timestamp DESC'
);

SELECT add_compression_policy('node_telemetry', INTERVAL '7 days', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS smart_city_attachments (
    attachment_id       SERIAL PRIMARY KEY,
    pole_id             INT NOT NULL REFERENCES poles(pole_id) ON DELETE CASCADE,
    sensor_type         VARCHAR(60) NOT NULL,
    manufacturer_id     VARCHAR(80),
    model_number        VARCHAR(80),
    firmware_version    VARCHAR(30),
    mac_address         VARCHAR(20) UNIQUE,
    commissioning_date  DATE,
    status              VARCHAR(20) DEFAULT 'ACTIVE'
                            CHECK (status IN ('ACTIVE','INACTIVE','FAULTY','DECOMMISSIONED')),
    config_json         JSONB,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attachment_telemetry (
    timestamp           TIMESTAMPTZ NOT NULL,
    attachment_id       INT NOT NULL REFERENCES smart_city_attachments(attachment_id) ON DELETE CASCADE,
    raw_data_payload    JSONB NOT NULL,
    ingest_latency_ms   INT,
    raw_packet_id       UUID DEFAULT uuid_generate_v4()
);

SELECT create_hypertable('attachment_telemetry','timestamp',chunk_time_interval => INTERVAL '1 day',if_not_exists => TRUE);

ALTER TABLE attachment_telemetry SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'attachment_id',
    timescaledb.compress_orderby   = 'timestamp DESC'
);

SELECT add_compression_policy('attachment_telemetry', INTERVAL '7 days', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_poles_geo       ON poles          USING GIST(geolocation);
CREATE INDEX IF NOT EXISTS idx_jbox_geo        ON junction_boxes USING GIST(installation_location);
CREATE INDEX IF NOT EXISTS idx_wo_status       ON work_orders(ticket_status);
CREATE INDEX IF NOT EXISTS idx_wo_contractor   ON work_orders(contractor_id);
CREATE INDEX IF NOT EXISTS idx_wo_pole         ON work_orders(pole_id);
CREATE INDEX IF NOT EXISTS idx_wo_reported     ON work_orders(reported_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_tel_pole        ON node_telemetry(pole_number, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_att_tel_payload ON attachment_telemetry USING GIN(raw_data_payload);
CREATE INDEX IF NOT EXISTS idx_poles_status    ON poles(current_status);
CREATE INDEX IF NOT EXISTS idx_att_sensor_type ON smart_city_attachments(sensor_type);

CREATE OR REPLACE VIEW v_contractor_kpis AS
SELECT
    c.contractor_id,
    c.company_name,
    z.zone_name,
    c.target_glow_rate,
    c.active_crews_deployed,
    c.total_pending,
    c.total_solved_daily,
    c.monthly_invoice_base,
    c.total_penalty_mtd,
    ROUND((c.monthly_invoice_base - c.total_penalty_mtd) / NULLIF(c.monthly_invoice_base,0) * 100, 2) AS net_payment_pct,
    COUNT(wo.work_order_id) FILTER (WHERE wo.ticket_status = 'SLA_VIOLATED') AS sla_violations_mtd,
    COUNT(wo.work_order_id) FILTER (WHERE wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS')) AS open_tickets
FROM contractors c
LEFT JOIN zones z ON c.assigned_zone_id = z.zone_id
LEFT JOIN work_orders wo ON wo.contractor_id = c.contractor_id
    AND wo.reported_timestamp >= date_trunc('month', NOW())
GROUP BY c.contractor_id, z.zone_name;

CREATE OR REPLACE VIEW v_sla_breaches AS
SELECT
    wo.work_order_id,
    wo.pole_id,
    p.pole_number,
    w.ward_amenity_sec_name,
    w.secretariat_code,
    z.zone_name,
    c.company_name AS contractor_name,
    wo.fault_category,
    wo.reported_timestamp,
    wo.sla_deadline,
    EXTRACT(EPOCH FROM (NOW() - wo.sla_deadline)) / 3600.0 AS hours_overdue,
    CEIL(EXTRACT(EPOCH FROM (NOW() - wo.sla_deadline)) / 86400.0) AS days_overdue
FROM work_orders wo
JOIN poles p        ON wo.pole_id      = p.pole_id
JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id
JOIN wards w        ON jb.ward_id      = w.ward_id
JOIN zones z        ON w.zone_id       = z.zone_id
LEFT JOIN contractors c ON wo.contractor_id = c.contractor_id
WHERE wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS')
  AND NOW() > wo.sla_deadline
ORDER BY wo.sla_deadline ASC;

CREATE OR REPLACE VIEW v_zone_glow_rates AS
SELECT
    z.zone_id,
    z.zone_name,
    COUNT(p.pole_id) AS total_poles,
    COUNT(p.pole_id) FILTER (WHERE p.current_status = 'OPERATIONAL') AS operational_poles,
    ROUND(COUNT(p.pole_id) FILTER (WHERE p.current_status = 'OPERATIONAL')::NUMERIC
        / NULLIF(COUNT(p.pole_id),0) * 100, 2) AS glow_rate_pct,
    COUNT(p.pole_id) FILTER (WHERE p.current_status = 'FAULTY') AS faulty_poles,
    COUNT(p.pole_id) FILTER (WHERE p.current_status = 'DAY_BURN') AS day_burn_poles
FROM zones z
LEFT JOIN wards w ON w.zone_id = z.zone_id
LEFT JOIN junction_boxes jb ON jb.ward_id = w.ward_id
LEFT JOIN poles p ON p.cabinet_id = jb.cabinet_id
GROUP BY z.zone_id, z.zone_name
ORDER BY glow_rate_pct ASC;