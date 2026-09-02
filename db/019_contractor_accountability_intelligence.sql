-- 019_contractor_accountability_intelligence.sql
-- Contract-level accountability, repeat-failure and evidence-backed performance.
-- Does not alter SLA deadlines, breach conditions, or glow-rate formulas.

CREATE TABLE IF NOT EXISTS contractor_performance_snapshots (
    snapshot_id BIGSERIAL PRIMARY KEY,
    contractor_id INT NOT NULL REFERENCES contractors(contractor_id) ON DELETE CASCADE,
    as_of_date DATE NOT NULL,
    total_orders INT NOT NULL DEFAULT 0 CHECK (total_orders >= 0),
    resolved_orders INT NOT NULL DEFAULT 0 CHECK (resolved_orders >= 0),
    sla_violations INT NOT NULL DEFAULT 0 CHECK (sla_violations >= 0),
    penalized_orders INT NOT NULL DEFAULT 0 CHECK (penalized_orders >= 0),
    repeat_failure_orders INT NOT NULL DEFAULT 0 CHECK (repeat_failure_orders >= 0),
    evidence_backed_resolutions INT NOT NULL DEFAULT 0 CHECK (evidence_backed_resolutions >= 0),
    avg_resolution_hours NUMERIC(12,2),
    total_penalty_inr NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total_penalty_inr >= 0),
    workload_open_orders INT NOT NULL DEFAULT 0 CHECK (workload_open_orders >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(contractor_id, as_of_date)
);

CREATE INDEX IF NOT EXISTS idx_contractor_perf_snapshot_date
    ON contractor_performance_snapshots(as_of_date DESC, contractor_id);

CREATE INDEX IF NOT EXISTS idx_contractor_perf_snapshot_contractor
    ON contractor_performance_snapshots(contractor_id, as_of_date DESC);

CREATE OR REPLACE VIEW v_contractor_accountability AS
SELECT
    c.contractor_id,
    c.company_name,
    c.assigned_zone_id,
    z.zone_name,
    c.target_glow_rate,
    c.active_crews_deployed,
    c.monthly_invoice_base,
    c.total_penalty_mtd,
    COUNT(wo.work_order_id) FILTER (WHERE wo.reported_timestamp >= NOW() - INTERVAL '90 days') AS orders_90d,
    COUNT(wo.work_order_id) FILTER (
        WHERE wo.reported_timestamp >= NOW() - INTERVAL '90 days'
          AND wo.ticket_status = 'RESOLVED'
    ) AS resolved_90d,
    COUNT(wo.work_order_id) FILTER (
        WHERE wo.reported_timestamp >= NOW() - INTERVAL '90 days'
          AND wo.ticket_status = 'SLA_VIOLATED'
    ) AS sla_violations_90d,
    COUNT(wo.work_order_id) FILTER (
        WHERE wo.reported_timestamp >= NOW() - INTERVAL '90 days'
          AND wo.penalty_deducted > 0
    ) AS penalized_orders_90d,
    COUNT(DISTINCT wo.work_order_id) FILTER (
        WHERE wo.reported_timestamp >= NOW() - INTERVAL '90 days'
          AND EXISTS (
              SELECT 1
              FROM work_orders prior
              WHERE prior.pole_id = wo.pole_id
                AND prior.contractor_id = wo.contractor_id
                AND prior.work_order_id <> wo.work_order_id
                AND prior.reported_timestamp < wo.reported_timestamp
                AND prior.reported_timestamp >= wo.reported_timestamp - INTERVAL '90 days'
          )
    ) AS repeat_failure_orders_90d,
    COUNT(DISTINCT wo.work_order_id) FILTER (
        WHERE wo.ticket_status = 'RESOLVED'
          AND EXISTS (
              SELECT 1
              FROM work_order_evidence e
              WHERE e.work_order_id = wo.work_order_id
                AND e.evidence_type = 'AFTER'
          )
          AND EXISTS (
              SELECT 1
              FROM work_order_verifications v
              WHERE v.work_order_id = wo.work_order_id
                AND v.result = 'PASS'
          )
    ) AS evidence_backed_resolutions,
    COUNT(wo.work_order_id) FILTER (
        WHERE wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED')
    ) AS open_orders,
    ROUND(AVG(EXTRACT(EPOCH FROM (wo.resolved_timestamp - wo.reported_timestamp))/3600.0)
        FILTER (WHERE wo.resolved_timestamp IS NOT NULL), 2) AS avg_resolution_hours
FROM contractors c
LEFT JOIN zones z ON z.zone_id = c.assigned_zone_id
LEFT JOIN work_orders wo ON wo.contractor_id = c.contractor_id
GROUP BY c.contractor_id, c.company_name, c.assigned_zone_id, z.zone_name,
         c.target_glow_rate, c.active_crews_deployed,
         c.monthly_invoice_base, c.total_penalty_mtd;
