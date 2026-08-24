-- ═══════════════════════════════════════════════════════════════════════
-- WAR ROOM / CRISIS DETECTION — Grounded in real historical events
--
-- Thresholds below are calibrated against actual documented disasters
-- affecting this exact region, not arbitrary numbers:
--
-- Cyclone Hudhud (2014): 56,000 poles damaged, 27 substations,
--   ALL THREE districts (Vizag/Srikakulam/Vizianagaram) dark
--   SIMULTANEOUSLY within hours. City-wide catastrophe, war-footing
--   declared, Army/Navy deployed. This is the CATASTROPHIC tier.
--
-- Cyclone Titli (2018): 6,000-7,000 poles damaged, but concentrated
--   almost entirely in ONE district (Srikakulam) — Vizag was
--   "relatively less affected." A severe but geographically
--   CONCENTRATED event. This is the SEVERE ZONE tier, not city-wide.
--
-- Kerala floods (2018): 16,158 transformers, restoration measured
--   in DAYS not hours, mechanism was gradual water damage rather
--   than instant wind-snap. Different failure signature — slower
--   onset, still severe, informs why we track sustained decline
--   as its own pattern, not just sudden spikes.
--
-- CORE LESSON FROM ALL THREE: raw fault COUNT alone is meaningless —
-- it must be measured as a PERCENTAGE of that zone's total poles,
-- because zones vary in size. This is how real utility crisis
-- dashboards (KSEB, EPDCL) actually think about scale.
-- ═══════════════════════════════════════════════════════════════════════

-- ─── ZONE-LEVEL SEVERITY — percentage-of-zone-poles based, tiered ─────────
-- Replaces the old flat "5+ faults = crisis" rule with a scaled measure.
CREATE OR REPLACE VIEW v_zone_severity AS
SELECT
  z.zone_id,
  z.zone_name,
  COUNT(DISTINCT p.pole_id) AS total_poles_in_zone,
  COUNT(DISTINCT wo.pole_id) FILTER (
    WHERE wo.reported_timestamp >= NOW() - INTERVAL '1 hour'
      AND wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS')
  ) AS poles_faulted_last_hour,
  ROUND(
    COUNT(DISTINCT wo.pole_id) FILTER (
      WHERE wo.reported_timestamp >= NOW() - INTERVAL '1 hour'
        AND wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS')
    )::NUMERIC / NULLIF(COUNT(DISTINCT p.pole_id), 0) * 100, 2
  ) AS pct_zone_affected_1hr,
  CASE
    WHEN COUNT(DISTINCT p.pole_id) = 0 THEN 'NO_DATA'
    WHEN ROUND(
      COUNT(DISTINCT wo.pole_id) FILTER (
        WHERE wo.reported_timestamp >= NOW() - INTERVAL '1 hour'
          AND wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS')
      )::NUMERIC / NULLIF(COUNT(DISTINCT p.pole_id), 0) * 100, 2
    ) >= 5 THEN 'SEVERE'         -- Titli-scale: one zone hit hard
    WHEN ROUND(
      COUNT(DISTINCT wo.pole_id) FILTER (
        WHERE wo.reported_timestamp >= NOW() - INTERVAL '1 hour'
          AND wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS')
      )::NUMERIC / NULLIF(COUNT(DISTINCT p.pole_id), 0) * 100, 2
    ) >= 2 THEN 'ELEVATED'       -- worth watching, not yet crisis
    ELSE 'NORMAL'
  END AS severity_tier
FROM zones z
LEFT JOIN wards w          ON w.zone_id = z.zone_id
LEFT JOIN junction_boxes jb ON jb.ward_id = w.ward_id
LEFT JOIN poles p           ON p.cabinet_id = jb.cabinet_id
LEFT JOIN work_orders wo    ON wo.pole_id = p.pole_id
GROUP BY z.zone_id, z.zone_name;

COMMENT ON VIEW v_zone_severity IS
  'Per-zone severity as % of that zone''s poles currently faulted — scales correctly across zones of different sizes, unlike a raw count. Tiers: NORMAL <2%, ELEVATED 2-5% (worth watching), SEVERE 5%+ (Titli-scale single-zone crisis).';

-- ─── CITY-WIDE CATASTROPHIC — the Hudhud pattern ──────────────────────────
-- Multiple zones at SEVERE tier SIMULTANEOUSLY = distributed, city-wide
-- event, not a local contractor problem. This is what actually
-- distinguished Hudhud (catastrophic) from Titli (severe but contained).
CREATE OR REPLACE VIEW v_city_wide_crisis AS
SELECT
  COUNT(*) AS zones_at_severe_tier,
  array_agg(zone_name ORDER BY pct_zone_affected_1hr DESC) AS affected_zone_names,
  MAX(pct_zone_affected_1hr) AS worst_zone_pct_affected,
  'CITY_WIDE_CATASTROPHIC' AS pattern_type
FROM v_zone_severity
WHERE severity_tier = 'SEVERE'
HAVING COUNT(*) >= 3;

COMMENT ON VIEW v_city_wide_crisis IS
  'Fires only when 3+ zones are independently at SEVERE tier at the same time — the Hudhud pattern (all districts dark simultaneously), distinct from one zone having a bad day (Titli pattern, handled by v_zone_severity alone).';

-- ─── LIFE-SAFETY HAZARD — always independent, always immediate ───────────
-- A single downed/exposed wire is a public safety risk regardless of
-- zone-wide statistics. This must never wait on percentage thresholds.
CREATE OR REPLACE VIEW v_life_safety_hazards AS
SELECT
  wo.work_order_id,
  z.zone_id,
  z.zone_name,
  w.ward_number,
  p.pole_number,
  COALESCE(wo.recommended_fault, wo.fault_category) AS fault_type,
  wo.reported_timestamp,
  ROUND(EXTRACT(EPOCH FROM (NOW() - wo.reported_timestamp)) / 60.0, 1) AS minutes_open,
  'LIFE_SAFETY_HAZARD' AS pattern_type
FROM work_orders wo
JOIN poles p           ON wo.pole_id = p.pole_id
JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id
JOIN wards w           ON jb.ward_id = w.ward_id
JOIN zones z           ON w.zone_id = z.zone_id
WHERE wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS')
  AND wo.severity_hint = 'CRITICAL'
  AND (COALESCE(wo.recommended_fault, wo.fault_category) = 'LINE_FAULT');

COMMENT ON VIEW v_life_safety_hazards IS
  'Any single unresolved CRITICAL line fault — downed/exposed wire electrocution or fire risk. Triggers War Room attention alone, independent of zone-wide percentages, because public safety cannot wait on statistical thresholds.';

-- ─── SUSTAINED DECLINE — the Kerala-flood pattern ─────────────────────────
-- Gradual multi-hour degradation rather than a sudden spike. Tracked
-- separately because response strategy differs: this needs sustained
-- monitoring and resource staging, not the same "drop everything now"
-- response as a sudden wind-driven mass outage.
CREATE OR REPLACE VIEW v_sustained_decline AS
SELECT
  z.zone_id,
  z.zone_name,
  COUNT(DISTINCT wo.pole_id) FILTER (
    WHERE wo.reported_timestamp >= NOW() - INTERVAL '6 hours'
  ) AS faults_last_6hr,
  COUNT(DISTINCT wo.pole_id) FILTER (
    WHERE wo.reported_timestamp >= NOW() - INTERVAL '1 hour'
  ) AS faults_last_1hr,
  'SUSTAINED_DECLINE' AS pattern_type
FROM zones z
JOIN wards w             ON w.zone_id = z.zone_id
JOIN junction_boxes jb    ON jb.ward_id = w.ward_id
JOIN poles p              ON p.cabinet_id = jb.cabinet_id
JOIN work_orders wo       ON wo.pole_id = p.pole_id
WHERE wo.ticket_status IN ('PENDING','ASSIGNED','IN_PROGRESS')
GROUP BY z.zone_id, z.zone_name
HAVING COUNT(DISTINCT wo.pole_id) FILTER (WHERE wo.reported_timestamp >= NOW() - INTERVAL '6 hours') >= 15;

COMMENT ON VIEW v_sustained_decline IS
  'Flood-pattern detection: 15+ faults accumulated over 6 hours in one zone — gradual sustained degradation (Kerala-flood mechanism) rather than a sudden spike. Different response strategy than a wind-driven instant crisis.';

-- ═══════════════════════════════════════════════════════════════════════
-- COMMUNICATION BLACKOUT DETECTION — the real gap identified from Hudhud
--
-- "Communication has totally collapsed...power and telecommunication"
-- (Odisha CM, Hudhud). Cell towers and comms infrastructure fail FIRST
-- in a real disaster — often before we see faults, because we simply
-- stop hearing from that area entirely. A silent zone is not "no
-- problems" — it may mean "we've lost visibility," which is more
-- dangerous than a reported fault because nobody knows what's
-- happening there.
--
-- KEY DESIGN RULE: a single silent box means nothing (normal wear,
-- happens constantly). This must ONLY fire as a CLUSTER — multiple
-- boxes in the same ward/zone going dark together, in a short window,
-- after having reported normally just before. That pattern cannot be
-- routine hardware failure — it indicates something happened to the
-- shared infrastructure (power, comms backbone) serving that whole area.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW v_communication_blackout AS
WITH box_status AS (
  SELECT
    jb.cabinet_id,
    jb.ward_id,
    w.zone_id,
    jb.last_heartbeat,
    -- A box is "recently silent" if it had a heartbeat before
    -- (proving it normally reports) but nothing in the last 30 minutes
    CASE
      WHEN jb.last_heartbeat IS NOT NULL
       AND jb.last_heartbeat < NOW() - INTERVAL '30 minutes'
       AND jb.last_heartbeat > NOW() - INTERVAL '24 hours'
      THEN true
      ELSE false
    END AS is_recently_silent
  FROM junction_boxes jb
  JOIN wards w ON jb.ward_id = w.ward_id
)
SELECT
  zone_id,
  ward_id,
  COUNT(*) AS total_boxes_in_ward,
  COUNT(*) FILTER (WHERE is_recently_silent) AS silent_box_count,
  ROUND(
    COUNT(*) FILTER (WHERE is_recently_silent)::NUMERIC
    / NULLIF(COUNT(*), 0) * 100, 1
  ) AS pct_ward_silent,
  'COMMUNICATION_BLACKOUT' AS pattern_type
FROM box_status
GROUP BY zone_id, ward_id
HAVING
  -- Cluster rule: at least 3 boxes AND at least 50% of this ward's
  -- boxes went silent together — a single box alone never triggers this
  COUNT(*) FILTER (WHERE is_recently_silent) >= 3
  AND ROUND(
    COUNT(*) FILTER (WHERE is_recently_silent)::NUMERIC
    / NULLIF(COUNT(*), 0) * 100, 1
  ) >= 50;

COMMENT ON VIEW v_communication_blackout IS
  'Detects clusters of junction boxes that STOPPED reporting together (3+ boxes, 50%+ of a ward, silent 30min-24hr after previously reporting normally). This is the Hudhud comms-collapse pattern — loss of visibility itself is the danger signal, distinct from reported faults. A single silent box is excluded by design; only simultaneous cluster silence qualifies, since that cannot be routine individual hardware failure.';

-- ─── ZONE-LEVEL ROLLUP — combines blackout detection with severity ────────
-- A zone showing BOTH high fault percentage AND communication blackout
-- in overlapping wards is the strongest possible signal — faults we
-- can see plus infrastructure we've lost visibility into, together.
CREATE OR REPLACE VIEW v_zone_comms_health AS
SELECT
  z.zone_id,
  z.zone_name,
  COALESCE(cb.wards_with_blackout, 0) AS wards_with_comms_blackout,
  COALESCE(cb.total_silent_boxes, 0) AS total_silent_boxes
FROM zones z
LEFT JOIN (
  SELECT zone_id,
         COUNT(DISTINCT ward_id) AS wards_with_blackout,
         SUM(silent_box_count) AS total_silent_boxes
  FROM v_communication_blackout
  GROUP BY zone_id
) cb ON cb.zone_id = z.zone_id;

COMMENT ON VIEW v_zone_comms_health IS
  'Per-zone rollup of communication blackout clusters — join with v_zone_severity in the API layer to combine "faults we can see" with "areas we have lost visibility into" for a complete crisis picture.';