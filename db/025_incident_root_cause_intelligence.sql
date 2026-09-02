-- 025_incident_root_cause_intelligence.sql
-- Advisory root-cause intelligence. It records human-reviewed causal labels and
-- derives recurring patterns from existing incidents, fault episodes and work orders.

CREATE TABLE IF NOT EXISTS incident_root_causes (
    root_cause_id BIGSERIAL PRIMARY KEY,
    incident_id UUID NOT NULL REFERENCES incidents(incident_id) ON DELETE CASCADE,
    pole_id INT REFERENCES poles(pole_id) ON DELETE SET NULL,
    work_order_id INT REFERENCES work_orders(work_order_id) ON DELETE SET NULL,
    cause_category VARCHAR(60) NOT NULL CHECK (cause_category IN ('ELECTRICAL','DRIVER','CABINET','CABLE','PHYSICAL_DAMAGE','ENVIRONMENTAL','INSTALLATION','MAINTENANCE','VANDALISM_THEFT','UNKNOWN','OTHER')),
    cause_code VARCHAR(80),
    confidence NUMERIC(5,2) CHECK (confidence BETWEEN 0 AND 100),
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    determination_source VARCHAR(20) NOT NULL DEFAULT 'HUMAN' CHECK (determination_source IN ('HUMAN','RULE','AI_ADVISORY')),
    determined_by INT REFERENCES users(user_id) ON DELETE SET NULL,
    determined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_root_cause_incident ON incident_root_causes(incident_id,determined_at DESC);
CREATE INDEX IF NOT EXISTS idx_root_cause_pole ON incident_root_causes(pole_id,determined_at DESC);
CREATE INDEX IF NOT EXISTS idx_root_cause_category ON incident_root_causes(cause_category,determined_at DESC);

CREATE OR REPLACE VIEW v_incident_root_cause_patterns AS
SELECT irc.cause_category,COALESCE(irc.cause_code,'UNSPECIFIED') AS cause_code,
 COUNT(*)::int AS incident_count,
 COUNT(DISTINCT irc.pole_id)::int AS affected_assets,
 COUNT(DISTINCT wo.contractor_id)::int AS contractors_impacted,
 ROUND(AVG(irc.confidence),2) AS avg_confidence,
 MAX(irc.determined_at) AS last_determined_at
FROM incident_root_causes irc
LEFT JOIN work_orders wo ON wo.work_order_id=irc.work_order_id
GROUP BY irc.cause_category,COALESCE(irc.cause_code,'UNSPECIFIED');

CREATE OR REPLACE VIEW v_asset_failure_patterns AS
WITH failures AS (
 SELECT p.pole_id,p.pole_number,p.road_name,z.zone_id,z.zone_name,
        COUNT(DISTINCT fe.episode_id) FILTER (WHERE fe.first_detected_at >= NOW()-INTERVAL '365 days')::int AS fault_episodes_365d,
        COUNT(DISTINCT wo.work_order_id) FILTER (WHERE wo.reported_timestamp >= NOW()-INTERVAL '365 days')::int AS work_orders_365d,
        COUNT(DISTINCT wo.work_order_id) FILTER (WHERE wo.reported_timestamp >= NOW()-INTERVAL '365 days' AND wo.ticket_status='SLA_VIOLATED')::int AS sla_violations_365d
 FROM poles p
 JOIN junction_boxes j ON j.cabinet_id=p.cabinet_id
 JOIN wards w ON w.ward_id=j.ward_id
 JOIN zones z ON z.zone_id=w.zone_id
 LEFT JOIN fault_episodes fe ON fe.pole_id=p.pole_id
 LEFT JOIN work_orders wo ON wo.pole_id=p.pole_id
 WHERE p.current_status <> 'DECOMMISSIONED'
 GROUP BY p.pole_id,p.pole_number,p.road_name,z.zone_id,z.zone_name
), causes AS (
 SELECT pole_id,string_agg(cause_category,', ' ORDER BY cnt DESC) AS observed_root_causes
 FROM (SELECT pole_id,cause_category,COUNT(*) cnt FROM incident_root_causes WHERE pole_id IS NOT NULL GROUP BY pole_id,cause_category) x
 GROUP BY pole_id
)
SELECT f.*,COALESCE(c.observed_root_causes,'UNCLASSIFIED') AS observed_root_causes,
 CASE WHEN f.fault_episodes_365d >= 6 OR f.work_orders_365d >= 8 THEN 'SYSTEMIC'
      WHEN f.fault_episodes_365d >= 3 OR f.work_orders_365d >= 4 THEN 'RECURRING'
      WHEN f.fault_episodes_365d >= 1 OR f.work_orders_365d >= 1 THEN 'ISOLATED'
      ELSE 'NONE' END AS failure_pattern
FROM failures f LEFT JOIN causes c ON c.pole_id=f.pole_id;
