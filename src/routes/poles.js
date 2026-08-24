const express = require('express');
const router  = express.Router();
const Joi     = require('joi');
const db      = require('../../config/database');
const logger  = require('../utils/logger');
const { requireAuth, requireRole, auditLog } = require('../middleware/auth');

// ─── Protect ALL pole routes ──────────────────────────────────────────────────
router.use(requireAuth);

// ─── Validation schemas ───────────────────────────────────────────────────────
const createPoleSchema = Joi.object({
  pole_number:       Joi.string().max(30).required(),
  cabinet_id:        Joi.number().integer().required(),
  wiring_type:       Joi.string().valid('OVERHEAD','UNDERGROUND').required(),
  luminaire_wattage: Joi.number().valid(20,40,70,110,120,150).required(),
  node_id:           Joi.string().max(50).optional().allow('',null),
  latitude:          Joi.number().min(-90).max(90).required(),
  longitude:         Joi.number().min(-180).max(180).required(),
  road_name:         Joi.string().max(200).optional().allow('',null),
  installation_date: Joi.string().isoDate().optional().allow(null),
});

const updatePoleSchema = Joi.object({
  current_status:    Joi.string().valid(
    'OPERATIONAL','FAULTY','UNDER_REPAIR',
    'DECOMMISSIONED','DAY_BURN','NO_SIGNAL'
  ).optional(),
  node_id:           Joi.string().max(50).optional().allow('',null),
  road_name:         Joi.string().max(200).optional().allow('',null),
  luminaire_wattage: Joi.number().valid(20,40,70,110,120,150).optional(),
  wiring_type:       Joi.string().valid('OVERHEAD','UNDERGROUND').optional(),
  last_maintenance:  Joi.string().isoDate().optional().allow(null),
});

// ─── GET /api/v1/poles/zones — Zone glow rates ───────────────────────────────
router.get('/zones', async (req, res) => {
  try {
    const zones = await db.manyOrNone(`
      SELECT zone_id, zone_name, total_poles,
             operational_poles, glow_rate_pct,
             faulty_poles, day_burn_poles
      FROM v_zone_glow_rates
      ORDER BY zone_name
    `);

    const cityTotal = await db.oneOrNone(
      `SELECT COUNT(*) AS total FROM poles
       WHERE current_status != 'DECOMMISSIONED'`
    );

    res.json({
      ok: true,
      city_total_poles: parseInt(process.env.TOTAL_POLES) || 200000,
      db_total_poles:   parseInt(cityTotal?.total || 0),
      zones,
    });
  } catch (err) {
    logger.error('Get zones error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── GET /api/v1/poles — List poles ──────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const limit    = Math.min(parseInt(req.query.limit)  || 50, 500);
    const offset   = parseInt(req.query.offset) || 0;
    const status   = req.query.status;
    const zoneId   = req.query.zone_id;
    const wardId   = req.query.ward_id;
    const cabinetId = req.query.cabinet_id;

    const conditions = [];
    const params     = [];
    let   idx        = 1;

    // EE sees only their zone
    if (req.user.role === 'GVMC_EE' && req.user.zone_id) {
      conditions.push(`w.zone_id = $${idx++}`);
      params.push(req.user.zone_id);
    } else if (zoneId) {
      conditions.push(`w.zone_id = $${idx++}`);
      params.push(parseInt(zoneId));
    }

    if (status) {
      conditions.push(`p.current_status = $${idx++}`);
      params.push(status);
    }
    if (wardId) {
      conditions.push(`jb.ward_id = $${idx++}`);
      params.push(parseInt(wardId));
    }
    if (cabinetId) {
      conditions.push(`p.cabinet_id = $${idx++}`);
      params.push(parseInt(cabinetId));
    }

    const whereClause = conditions.length
      ? 'WHERE ' + conditions.join(' AND ')
      : '';

    params.push(limit, offset);

    const poles = await db.manyOrNone(`
      SELECT p.pole_id, p.pole_number, p.cabinet_id,
             p.wiring_type, p.luminaire_wattage, p.node_id,
             p.road_name, p.installation_date, p.last_maintenance,
             p.current_status, p.created_at,
             ST_Y(p.geolocation::geometry) AS latitude,
             ST_X(p.geolocation::geometry) AS longitude,
             jb.cabinet_serial_no, jb.ward_id,
             w.ward_number, w.secretariat_code,
             z.zone_id, z.zone_name
      FROM poles p
      JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id
      JOIN wards w ON jb.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      ${whereClause}
      ORDER BY p.pole_number
      LIMIT $${idx++} OFFSET $${idx++}
    `, params);

    res.json({ ok: true, count: poles.length, data: poles });
  } catch (err) {
    logger.error('Get poles error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── GET /api/v1/poles/:id ────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const pole = await db.oneOrNone(`
      SELECT p.*,
             ST_Y(p.geolocation::geometry) AS latitude,
             ST_X(p.geolocation::geometry) AS longitude,
             jb.cabinet_serial_no, jb.ward_id,
             jb.contactor_status, jb.last_heartbeat,
             w.ward_number, w.secretariat_code,
             w.ward_amenity_sec_name, w.ward_amenity_sec_phone,
             z.zone_id, z.zone_name
      FROM poles p
      JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id
      JOIN wards w ON jb.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      WHERE p.pole_id = $1
    `, [parseInt(req.params.id)]);

    if (!pole) return res.status(404).json({ ok: false, error: 'Pole not found' });

    // EE can only see their zone
    if (req.user.role === 'GVMC_EE' &&
        req.user.zone_id &&
        pole.zone_id !== req.user.zone_id) {
      return res.status(403).json({ ok: false, error: 'Access denied' });
    }

    res.json({ ok: true, data: pole });
  } catch (err) {
    logger.error('Get pole error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── POST /api/v1/poles — Add new pole ───────────────────────────────────────
router.post('/',
  requireRole('SUPER_ADMIN', 'GVMC_COMMISSIONER', 'GVMC_EE'),
  async (req, res) => {
    const { error, value } = createPoleSchema.validate(req.body);
    if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

    try {
      // Check pole number uniqueness
      const existing = await db.oneOrNone(
        'SELECT pole_id FROM poles WHERE pole_number = $1', [value.pole_number]
      );
      if (existing) {
        return res.status(409).json({
          ok: false, error: 'Pole number already exists'
        });
      }

      // Verify cabinet exists
      const cabinet = await db.oneOrNone(
        'SELECT cabinet_id FROM junction_boxes WHERE cabinet_id = $1',
        [value.cabinet_id]
      );
      if (!cabinet) {
        return res.status(404).json({ ok: false, error: 'Junction box not found' });
      }

      const pole = await db.one(`
        INSERT INTO poles
          (pole_number, cabinet_id, wiring_type, luminaire_wattage,
           node_id, geolocation, road_name, installation_date)
        VALUES ($1, $2, $3, $4, $5,
                ST_SetSRID(ST_MakePoint($7, $6), 4326),
                $8, $9)
        RETURNING pole_id, pole_number, current_status, created_at
      `, [
        value.pole_number,
        value.cabinet_id,
        value.wiring_type,
        value.luminaire_wattage,
        value.node_id || null,
        value.latitude,
        value.longitude,
        value.road_name || null,
        value.installation_date || null,
      ]);

      await auditLog(req.user.user_id, 'POLE_CREATED', 'poles',
        pole.pole_id, true, { pole_number: value.pole_number }, req);

      logger.info('Pole created', { pole_id: pole.pole_id, by: req.user.user_id });
      res.status(201).json({ ok: true, data: pole });
    } catch (err) {
      logger.error('Create pole error', { error: err.message });
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  }
);

// ─── PATCH /api/v1/poles/:id — Update pole ───────────────────────────────────
router.patch('/:id',
  requireRole('SUPER_ADMIN', 'GVMC_COMMISSIONER', 'GVMC_EE'),
  async (req, res) => {
    const { error, value } = updatePoleSchema.validate(req.body);
    if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

    try {
      const pole = await db.oneOrNone(
        'SELECT pole_id FROM poles WHERE pole_id = $1', [parseInt(req.params.id)]
      );
      if (!pole) return res.status(404).json({ ok: false, error: 'Pole not found' });

      const updates = [];
      const params  = [];
      let   idx     = 1;

      if (value.current_status) {
        updates.push(`current_status = $${idx++}`);
        params.push(value.current_status);
      }
      if (value.node_id !== undefined) {
        updates.push(`node_id = $${idx++}`);
        params.push(value.node_id);
      }
      if (value.road_name !== undefined) {
        updates.push(`road_name = $${idx++}`);
        params.push(value.road_name);
      }
      if (value.luminaire_wattage) {
        updates.push(`luminaire_wattage = $${idx++}`);
        params.push(value.luminaire_wattage);
      }
      if (value.wiring_type) {
        updates.push(`wiring_type = $${idx++}`);
        params.push(value.wiring_type);
      }
      if (value.last_maintenance !== undefined) {
        updates.push(`last_maintenance = $${idx++}`);
        params.push(value.last_maintenance);
      }

      if (!updates.length) {
        return res.status(400).json({ ok: false, error: 'No fields to update' });
      }

      params.push(parseInt(req.params.id));
      await db.none(
        `UPDATE poles SET ${updates.join(', ')} WHERE pole_id = $${idx}`,
        params
      );

      await auditLog(req.user.user_id, 'POLE_UPDATED', 'poles',
        parseInt(req.params.id), true, { changes: value }, req);

      res.json({ ok: true, message: 'Pole updated successfully' });
    } catch (err) {
      logger.error('Update pole error', { error: err.message });
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  }
);

// ─── DELETE /api/v1/poles/:id — Decommission pole ────────────────────────────
router.delete('/:id',
  requireRole('SUPER_ADMIN', 'GVMC_COMMISSIONER'),
  async (req, res) => {
    try {
      const pole = await db.oneOrNone(
        'SELECT pole_id, pole_number, current_status FROM poles WHERE pole_id = $1',
        [parseInt(req.params.id)]
      );
      if (!pole) return res.status(404).json({ ok: false, error: 'Pole not found' });

      if (pole.current_status === 'DECOMMISSIONED') {
        return res.status(400).json({ ok: false, error: 'Pole already decommissioned' });
      }

      // Soft delete — never hard delete poles
      await db.none(
        `UPDATE poles SET current_status = 'DECOMMISSIONED' WHERE pole_id = $1`,
        [parseInt(req.params.id)]
      );

      await auditLog(req.user.user_id, 'POLE_DECOMMISSIONED', 'poles',
        parseInt(req.params.id), true,
        { pole_number: pole.pole_number }, req);

      logger.warn('Pole decommissioned', {
        pole_id: parseInt(req.params.id),
        by: req.user.user_id
      });

      res.json({ ok: true, message: `Pole ${pole.pole_number} decommissioned` });
    } catch (err) {
      logger.error('Decommission pole error', { error: err.message });
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  }
);

// ─── GET /api/v1/poles/search/:query ─────────────────────────────────────────
router.get('/search/:query', async (req, res) => {
  try {
    const query = req.params.query.trim();
    if (query.length < 2) {
      return res.status(400).json({ ok: false, error: 'Search query too short' });
    }

    const poles = await db.manyOrNone(`
      SELECT p.pole_id, p.pole_number, p.current_status,
             p.luminaire_wattage, p.wiring_type,
             ST_Y(p.geolocation::geometry) AS latitude,
             ST_X(p.geolocation::geometry) AS longitude,
             z.zone_name, w.ward_number
      FROM poles p
      JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id
      JOIN wards w ON jb.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      WHERE p.pole_number ILIKE $1
         OR p.road_name   ILIKE $1
      ORDER BY p.pole_number
      LIMIT 20
    `, [`%${query}%`]);

    res.json({ ok: true, count: poles.length, data: poles });
  } catch (err) {
    logger.error('Pole search error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── GET /api/v1/poles/glow-history ──────────────────────────────────────────
router.get('/glow-history', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 12;
    const zoneId = req.query.zone_id;

    // Get snapshots if they exist
    let snapshots = await db.manyOrNone(`
      SELECT snapshot_month, zone_id, zone_name,
             glow_rate_pct, target_glow_rate,
             met_target, company_name
      FROM monthly_glow_snapshots
      WHERE ($1::int IS NULL OR zone_id = $1)
      ORDER BY snapshot_month DESC
      LIMIT $2
    `, [zoneId || null, months * 7]);

    // If no snapshots yet return current data
    if(!snapshots || !snapshots.length){
      const current = await db.manyOrNone(`
        SELECT zone_id, zone_name,
               glow_rate_pct,
               total_poles, operational_poles
        FROM v_zone_glow_rates
        ORDER BY zone_name
      `);
      return res.json({
        ok: true,
        has_history: false,
        current_only: true,
        data: current
      });
    }

    res.json({ ok: true, has_history: true, data: snapshots });
  } catch(err){
    logger.error('Glow history error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── GET /api/v1/poles/crisis-status ─────────────────────────────────────────
// Checks ALL crisis patterns and returns a combined, tiered assessment.
// Each pattern is independently sufficient — a single life-safety hazard
// or comms blackout cluster triggers War Room even if zone-wide percentages
// look normal. This reflects real disaster response: you don't wait for
// multiple conditions to stack before treating a downed wire seriously.
router.get('/crisis-status', async (req, res) => {
  try {
    const [
      zoneSeverity,
      cityWideCrisis,
      lifeSafety,
      sustainedDecline,
      commsBlackout,
    ] = await Promise.all([
      db.manyOrNone(`SELECT * FROM v_zone_severity WHERE severity_tier IN ('ELEVATED','SEVERE') ORDER BY pct_zone_affected_1hr DESC`),
      db.manyOrNone(`SELECT * FROM v_city_wide_crisis`),
      db.manyOrNone(`SELECT * FROM v_life_safety_hazards ORDER BY minutes_open ASC`),
      db.manyOrNone(`SELECT * FROM v_sustained_decline ORDER BY faults_last_6hr DESC`),
      db.manyOrNone(`SELECT * FROM v_communication_blackout ORDER BY pct_ward_silent DESC`),
    ]);

    // ── Determine overall tier — worst pattern wins ──
    // CATASTROPHIC beats everything: city-wide event (Hudhud pattern)
    // CRITICAL: any life-safety hazard OR any comms blackout cluster —
    //   these are independently serious regardless of scale
    // SEVERE: at least one zone individually at SEVERE tier (Titli pattern)
    // ELEVATED: zones showing early warning signs, worth watching
    // NORMAL: none of the above
    let overallTier = 'NORMAL';
    const activePatterns = [];

    if (lifeSafety.length > 0) {
      overallTier = 'CRITICAL';
      activePatterns.push({
        pattern: 'LIFE_SAFETY_HAZARD',
        severity: 'CRITICAL',
        summary: `${lifeSafety.length} unresolved downed/exposed-wire hazard(s) — public safety risk`,
        detail: lifeSafety,
      });
    }

    if (commsBlackout.length > 0) {
      overallTier = 'CRITICAL';
      activePatterns.push({
        pattern: 'COMMUNICATION_BLACKOUT',
        severity: 'CRITICAL',
        summary: `${commsBlackout.length} ward(s) have lost communication with a cluster of junction boxes — visibility lost, not just faults`,
        detail: commsBlackout,
      });
    }

    if (cityWideCrisis.length > 0) {
      overallTier = 'CATASTROPHIC';
      activePatterns.push({
        pattern: 'CITY_WIDE_CATASTROPHIC',
        severity: 'CATASTROPHIC',
        summary: `${cityWideCrisis[0].zones_at_severe_tier} zones simultaneously at severe tier — city-wide event`,
        detail: cityWideCrisis,
      });
    }

    const severeZones = zoneSeverity.filter(z => z.severity_tier === 'SEVERE');
    if (severeZones.length > 0 && overallTier !== 'CATASTROPHIC') {
      overallTier = 'SEVERE';
    }
    if (severeZones.length > 0) {
      activePatterns.push({
        pattern: 'ZONE_SEVERE',
        severity: 'SEVERE',
        summary: `${severeZones.length} zone(s) individually at severe fault levels`,
        detail: severeZones,
      });
    }

    const elevatedZones = zoneSeverity.filter(z => z.severity_tier === 'ELEVATED');
    if (elevatedZones.length > 0 && overallTier === 'NORMAL') {
      overallTier = 'ELEVATED';
    }
    if (elevatedZones.length > 0) {
      activePatterns.push({
        pattern: 'ZONE_ELEVATED',
        severity: 'ELEVATED',
        summary: `${elevatedZones.length} zone(s) showing early warning signs`,
        detail: elevatedZones,
      });
    }

    if (sustainedDecline.length > 0) {
      activePatterns.push({
        pattern: 'SUSTAINED_DECLINE',
        severity: 'WATCH',
        summary: `${sustainedDecline.length} zone(s) showing gradual multi-hour degradation`,
        detail: sustainedDecline,
      });
    }

    // War Room UI should trigger for CRITICAL, SEVERE, or CATASTROPHIC —
    // ELEVATED and WATCH are shown as warnings but don't take over the screen
    const warRoomActive = ['CRITICAL', 'SEVERE', 'CATASTROPHIC'].includes(overallTier);

    res.json({
      ok: true,
      overall_tier: overallTier,
      war_room_active: warRoomActive,
      active_patterns: activePatterns,
      checked_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('Crisis status check error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

module.exports = router;