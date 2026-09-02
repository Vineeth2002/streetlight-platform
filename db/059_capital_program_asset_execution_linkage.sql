BEGIN;

CREATE TABLE IF NOT EXISTS municipal_capital_program_asset_links (
  link_id BIGSERIAL PRIMARY KEY,
  capital_program_id BIGINT NOT NULL REFERENCES municipal_capital_programs(capital_program_id) ON DELETE CASCADE,
  pole_id INT NOT NULL REFERENCES poles(pole_id) ON DELETE RESTRICT,
  work_order_id INT REFERENCES work_orders(work_order_id) ON DELETE SET NULL,
  linkage_type VARCHAR(30) NOT NULL DEFAULT 'PLANNED_ASSET'
    CHECK (linkage_type IN ('PLANNED_ASSET','EXECUTION_WORK_ORDER')),
  linked_by INT REFERENCES users(user_id) ON DELETE SET NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(capital_program_id,pole_id,work_order_id)
);

CREATE INDEX IF NOT EXISTS idx_capital_program_asset_links_program
  ON municipal_capital_program_asset_links(capital_program_id,pole_id);
CREATE INDEX IF NOT EXISTS idx_capital_program_asset_links_wo
  ON municipal_capital_program_asset_links(work_order_id);

CREATE OR REPLACE VIEW v_municipal_capital_program_execution AS
SELECT l.capital_program_id,cp.program_key,cp.title,cp.zone_id,
       l.link_id,l.pole_id,p.pole_number,p.road_name,p.current_status,
       l.work_order_id,wo.ticket_status AS work_order_status,wo.fault_category,
       wo.reported_timestamp,wo.assigned_timestamp,wo.resolved_timestamp,
       CASE WHEN wo.work_order_id IS NULL THEN 'NOT_STARTED'
            WHEN wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED') THEN 'WORK_IN_PROGRESS'
            WHEN wo.ticket_status='RESOLVED' THEN
              CASE WHEN EXISTS (SELECT 1 FROM work_order_verifications v WHERE v.work_order_id=wo.work_order_id AND v.result='PASS') THEN 'VERIFIED'
                   ELSE 'RESOLVED_AWAITING_VERIFICATION' END
            WHEN wo.ticket_status='CANCELLED' THEN 'CANCELLED'
            ELSE 'UNKNOWN' END AS execution_state,
       (SELECT COUNT(*) FROM work_order_evidence e WHERE e.work_order_id=wo.work_order_id) AS evidence_count,
       (SELECT COUNT(*) FROM work_order_evidence e WHERE e.work_order_id=wo.work_order_id AND e.evidence_type='BEFORE') AS before_evidence_count,
       (SELECT COUNT(*) FROM work_order_evidence e WHERE e.work_order_id=wo.work_order_id AND e.evidence_type='AFTER') AS after_evidence_count,
       (SELECT COUNT(*) FROM work_order_verifications v WHERE v.work_order_id=wo.work_order_id AND v.result='PASS') AS pass_verification_count
FROM municipal_capital_program_asset_links l
JOIN municipal_capital_programs cp ON cp.capital_program_id=l.capital_program_id
JOIN poles p ON p.pole_id=l.pole_id
LEFT JOIN work_orders wo ON wo.work_order_id=l.work_order_id;

CREATE OR REPLACE VIEW v_municipal_capital_program_execution_summary AS
SELECT capital_program_id,program_key,title,zone_id,
       COUNT(*)::int AS linked_assets,
       COUNT(work_order_id)::int AS linked_work_orders,
       COUNT(*) FILTER (WHERE execution_state='VERIFIED')::int AS verified_work_orders,
       COUNT(*) FILTER (WHERE execution_state='WORK_IN_PROGRESS')::int AS active_work_orders,
       COUNT(*) FILTER (WHERE execution_state='RESOLVED_AWAITING_VERIFICATION')::int AS awaiting_verification,
       COUNT(*) FILTER (WHERE execution_state='NOT_STARTED')::int AS not_started,
       COALESCE(SUM(evidence_count),0)::int AS evidence_count,
       COALESCE(SUM(before_evidence_count),0)::int AS before_evidence_count,
       COALESCE(SUM(after_evidence_count),0)::int AS after_evidence_count
FROM v_municipal_capital_program_execution
GROUP BY capital_program_id,program_key,title,zone_id;

COMMIT;
