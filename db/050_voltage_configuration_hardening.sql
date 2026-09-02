-- 050_voltage_configuration_hardening.sql
-- Harden failure-propagation telemetry anomaly detection against cabinet-specific
-- nominal-voltage configuration. This replaces the legacy fixed 180-260V rule.
-- Advisory only: no pole state, work order, SLA, penalty, or glow-rate changes.

CREATE OR REPLACE VIEW v_failure_propagation_candidates AS
WITH recent_telemetry AS (
    SELECT
        p.pole_id,
        p.cabinet_id,
        jb.nominal_voltage,
        COUNT(nt.*) FILTER (
            WHERE nt.timestamp >= NOW() - INTERVAL '24 hours'
        )::int AS telemetry_samples_24h,
        COUNT(nt.*) FILTER (
            WHERE nt.timestamp >= NOW() - INTERVAL '24 hours'
              AND nt.voltage_rms IS NOT NULL
              AND jb.nominal_voltage IS NOT NULL
              AND jb.nominal_voltage > 0
              AND (
                  nt.voltage_rms < jb.nominal_voltage * 0.90
                  OR nt.voltage_rms > jb.nominal_voltage * 1.10
              )
        )::int AS voltage_anomalies_24h,
        MAX(nt.timestamp) AS last_telemetry_at
    FROM poles p
    LEFT JOIN junction_boxes jb ON jb.cabinet_id = p.cabinet_id
    LEFT JOIN node_telemetry nt
        ON nt.pole_number = p.pole_number OR nt.node_id = p.node_id
    GROUP BY p.pole_id, p.cabinet_id, jb.nominal_voltage
), asset_history AS (
    SELECT p.pole_id,
           COUNT(DISTINCT fe.episode_id) FILTER (WHERE fe.first_detected_at >= NOW() - INTERVAL '365 days')::int AS failure_episodes_365d,
           COUNT(DISTINCT wo.work_order_id) FILTER (WHERE wo.reported_timestamp >= NOW() - INTERVAL '365 days')::int AS work_orders_365d,
           COUNT(DISTINCT wo.work_order_id) FILTER (WHERE wo.ticket_status='SLA_VIOLATED' AND wo.reported_timestamp >= NOW() - INTERVAL '365 days')::int AS sla_violations_365d
    FROM poles p
    LEFT JOIN fault_episodes fe ON fe.pole_id=p.pole_id
    LEFT JOIN work_orders wo ON wo.pole_id=p.pole_id
    GROUP BY p.pole_id
), cabinet_rollup AS (
    SELECT
        n.cabinet_id,n.cabinet_serial_no,n.zone_id,n.zone_name,n.ward_id,n.ward_number,
        COUNT(*)::int AS connected_assets,
        COUNT(*) FILTER (WHERE n.current_status IN ('FAULTY','NO_SIGNAL','UNDER_REPAIR'))::int AS affected_assets,
        COUNT(*) FILTER (WHERE n.current_status='FAULTY')::int AS faulty_assets,
        COUNT(*) FILTER (WHERE n.current_status='NO_SIGNAL')::int AS no_signal_assets,
        COUNT(*) FILTER (WHERE n.current_status='UNDER_REPAIR')::int AS under_repair_assets,
        COUNT(*) FILTER (WHERE n.current_status='OPERATIONAL')::int AS operational_assets,
        COUNT(DISTINCT n.contractor_id) FILTER (WHERE n.contractor_id IS NOT NULL)::int AS contractors_involved,
        COUNT(DISTINCT n.work_order_id) FILTER (WHERE n.work_order_status IN ('PENDING','ASSIGNED','IN_PROGRESS','SLA_VIOLATED'))::int AS open_work_orders
    FROM v_municipal_network_topology n
    GROUP BY n.cabinet_id,n.cabinet_serial_no,n.zone_id,n.zone_name,n.ward_id,n.ward_number
), cabinet_history AS (
    SELECT p.cabinet_id,
           COUNT(DISTINCT fe.episode_id) FILTER (WHERE fe.first_detected_at >= NOW() - INTERVAL '365 days')::int AS failure_episodes_365d,
           COUNT(DISTINCT wo.work_order_id) FILTER (WHERE wo.reported_timestamp >= NOW() - INTERVAL '365 days')::int AS work_orders_365d,
           COUNT(DISTINCT wo.work_order_id) FILTER (WHERE wo.ticket_status='SLA_VIOLATED' AND wo.reported_timestamp >= NOW() - INTERVAL '365 days')::int AS sla_violations_365d,
           COUNT(DISTINCT irc.root_cause_id)::int AS root_cause_determinations,
           STRING_AGG(DISTINCT irc.cause_category, ', ' ORDER BY irc.cause_category) AS observed_root_cause_categories
    FROM poles p
    LEFT JOIN fault_episodes fe ON fe.pole_id=p.pole_id
    LEFT JOIN work_orders wo ON wo.pole_id=p.pole_id
    LEFT JOIN incident_root_causes irc ON irc.pole_id=p.pole_id
    GROUP BY p.cabinet_id
), current_signals AS (
    SELECT p.cabinet_id,
           COUNT(*) FILTER (WHERE p.current_status IN ('FAULTY','NO_SIGNAL','UNDER_REPAIR'))::int AS affected_assets,
           COUNT(*) FILTER (WHERE p.current_status='FAULTY')::int AS faulty_assets,
           COUNT(*) FILTER (WHERE p.current_status='NO_SIGNAL')::int AS no_signal_assets,
           COUNT(*) FILTER (WHERE rt.voltage_anomalies_24h>0)::int AS assets_with_voltage_anomaly,
           COUNT(*) FILTER (WHERE rt.last_telemetry_at IS NULL OR rt.last_telemetry_at < NOW() - INTERVAL '24 hours')::int AS telemetry_stale_assets
    FROM poles p
    LEFT JOIN recent_telemetry rt ON rt.pole_id=p.pole_id
    WHERE p.current_status<>'DECOMMISSIONED'
    GROUP BY p.cabinet_id
)
SELECT
    cr.*,
    COALESCE(ch.failure_episodes_365d,0) AS failure_episodes_365d,
    COALESCE(ch.work_orders_365d,0) AS work_orders_365d,
    COALESCE(ch.sla_violations_365d,0) AS sla_violations_365d,
    COALESCE(ch.root_cause_determinations,0) AS root_cause_determinations,
    ch.observed_root_cause_categories,
    COALESCE(cs.assets_with_voltage_anomaly,0) AS assets_with_voltage_anomaly,
    COALESCE(cs.telemetry_stale_assets,0) AS telemetry_stale_assets,
    ROUND(100.0*cr.affected_assets/NULLIF(cr.connected_assets,0),2) AS affected_pct,
    LEAST(100,ROUND(
        35*LEAST(1.0,cr.affected_assets/NULLIF(cr.connected_assets::numeric,0)) +
        20*LEAST(1.0,COALESCE(ch.failure_episodes_365d,0)/6.0) +
        15*LEAST(1.0,COALESCE(ch.sla_violations_365d,0)/3.0) +
        15*LEAST(1.0,COALESCE(cs.assets_with_voltage_anomaly,0)/3.0) +
        10*LEAST(1.0,cr.open_work_orders/5.0) +
        5*LEAST(1.0,cr.no_signal_assets/3.0)
    ,2)) AS propagation_risk_score,
    CASE
        WHEN cr.affected_assets>=5 OR COALESCE(ch.sla_violations_365d,0)>=5 OR
             (cr.affected_assets>=3 AND 100.0*cr.affected_assets/NULLIF(cr.connected_assets,0)>=50) THEN 'CRITICAL'
        WHEN cr.affected_assets>=3 OR COALESCE(ch.failure_episodes_365d,0)>=6 OR COALESCE(ch.sla_violations_365d,0)>=3 THEN 'HIGH'
        WHEN cr.affected_assets>=1 OR COALESCE(ch.failure_episodes_365d,0)>=3 OR COALESCE(cs.assets_with_voltage_anomaly,0)>=1 THEN 'MEDIUM'
        ELSE 'LOW'
    END AS propagation_risk_band,
    CASE
        WHEN cr.affected_assets>0 THEN 'CABINET_SHARED_DEPENDENCY'
        WHEN COALESCE(ch.failure_episodes_365d,0)>0 THEN 'HISTORICAL_RECURRENT_FAILURE'
        WHEN COALESCE(cs.assets_with_voltage_anomaly,0)>0 THEN 'CURRENT_TELEMETRY_ANOMALY'
        ELSE 'NO_ACTIVE_PROPAGATION_SIGNAL'
    END AS propagation_signal
FROM cabinet_rollup cr
LEFT JOIN cabinet_history ch ON ch.cabinet_id=cr.cabinet_id
LEFT JOIN current_signals cs ON cs.cabinet_id=cr.cabinet_id;

CREATE OR REPLACE VIEW v_failure_propagation_summary AS
SELECT zone_id,zone_name,
       COUNT(*)::int AS cabinets,
       COUNT(*) FILTER (WHERE propagation_risk_band='CRITICAL')::int AS critical_cabinets,
       COUNT(*) FILTER (WHERE propagation_risk_band='HIGH')::int AS high_risk_cabinets,
       COUNT(*) FILTER (WHERE propagation_risk_band='MEDIUM')::int AS medium_risk_cabinets,
       SUM(affected_assets)::int AS affected_assets,
       SUM(open_work_orders)::int AS open_work_orders,
       SUM(sla_violations_365d)::int AS sla_violations_365d,
       ROUND(AVG(propagation_risk_score),2) AS avg_propagation_risk
FROM v_failure_propagation_candidates
GROUP BY zone_id,zone_name;
