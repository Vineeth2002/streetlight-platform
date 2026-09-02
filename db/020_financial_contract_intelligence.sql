-- 020_financial_contract_intelligence.sql
-- Financial intelligence is an auditable read model. It does not alter
-- penalty formulas, SLA rules, payment execution, or glow-rate calculations.

CREATE TABLE IF NOT EXISTS contract_financial_snapshots (
    snapshot_id BIGSERIAL PRIMARY KEY,
    contract_id INT NOT NULL REFERENCES municipal_contracts(contract_id) ON DELETE CASCADE,
    as_of_date DATE NOT NULL,
    contract_value_inr NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (contract_value_inr >= 0),
    awarded_value_inr NUMERIC(16,2),
    estimated_value_inr NUMERIC(16,2),
    variance_inr NUMERIC(16,2),
    variance_pct NUMERIC(8,2),
    invoice_base_inr NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (invoice_base_inr >= 0),
    penalties_inr NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (penalties_inr >= 0),
    net_payable_basis_inr NUMERIC(16,2) NOT NULL DEFAULT 0,
    work_order_count INT NOT NULL DEFAULT 0 CHECK (work_order_count >= 0),
    resolved_work_order_count INT NOT NULL DEFAULT 0 CHECK (resolved_work_order_count >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(contract_id, as_of_date)
);

CREATE INDEX IF NOT EXISTS idx_contract_financial_snapshot_date
    ON contract_financial_snapshots(as_of_date DESC, contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_financial_snapshot_contract
    ON contract_financial_snapshots(contract_id, as_of_date DESC);

CREATE OR REPLACE VIEW v_contract_financial_intelligence AS
SELECT
    c.contract_id,
    c.contract_number,
    c.title,
    c.contractor_id,
    co.company_name,
    co.assigned_zone_id,
    z.zone_name,
    c.status,
    c.start_date,
    c.end_date,
    c.contract_value_inr,
    pr.estimated_value_inr,
    pr.awarded_value_inr,
    CASE WHEN pr.estimated_value_inr IS NOT NULL AND pr.awarded_value_inr IS NOT NULL
         THEN pr.awarded_value_inr - pr.estimated_value_inr END AS procurement_variance_inr,
    CASE WHEN pr.estimated_value_inr > 0 AND pr.awarded_value_inr IS NOT NULL
         THEN ROUND((pr.awarded_value_inr - pr.estimated_value_inr) / pr.estimated_value_inr * 100, 2) END AS procurement_variance_pct,
    COALESCE(co.monthly_invoice_base,0) AS monthly_invoice_base_inr,
    COALESCE(co.total_penalty_mtd,0) AS penalty_mtd_inr,
    COALESCE(p.penalties_ledger_inr,0) AS penalties_ledger_inr,
    COALESCE(p.penalized_orders,0) AS penalized_orders,
    COALESCE(w.work_order_count,0) AS work_order_count,
    COALESCE(w.resolved_work_order_count,0) AS resolved_work_order_count,
    COALESCE(w.open_work_order_count,0) AS open_work_order_count,
    COALESCE(w.execution_penalty_inr,0) AS execution_penalty_inr,
    ROUND(COALESCE(co.monthly_invoice_base,0) - COALESCE(co.total_penalty_mtd,0),2) AS net_payable_basis_inr
FROM municipal_contracts c
JOIN contractors co ON co.contractor_id=c.contractor_id
LEFT JOIN zones z ON z.zone_id=co.assigned_zone_id
LEFT JOIN LATERAL (
    SELECT estimated_value_inr, awarded_value_inr
    FROM procurement_records x
    WHERE x.contract_id=c.contract_id
    ORDER BY COALESCE(x.award_date,x.notice_date) DESC NULLS LAST, x.procurement_id DESC
    LIMIT 1
) pr ON TRUE
LEFT JOIN LATERAL (
    SELECT COUNT(*)::int work_order_count,
           COUNT(*) FILTER (WHERE wo.ticket_status='RESOLVED')::int resolved_work_order_count,
           COUNT(*) FILTER (WHERE wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED'))::int open_work_order_count,
           COALESCE(SUM(wo.penalty_deducted),0) execution_penalty_inr
    FROM work_orders wo
    WHERE wo.contractor_id=c.contractor_id
      AND (c.start_date IS NULL OR wo.reported_timestamp >= c.start_date)
      AND (c.end_date IS NULL OR wo.reported_timestamp < c.end_date + INTERVAL '1 day')
) w ON TRUE
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(l.amount_inr),0) penalties_ledger_inr,
           COUNT(*)::int penalized_orders
    FROM contractor_penalty_ledger l
    WHERE l.contractor_id=c.contractor_id
      AND (c.start_date IS NULL OR l.assessed_at >= c.start_date)
      AND (c.end_date IS NULL OR l.assessed_at < c.end_date + INTERVAL '1 day')
) p ON TRUE;
