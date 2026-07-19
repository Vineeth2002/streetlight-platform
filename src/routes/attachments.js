const express = require('express');
const router  = express.Router();
const Joi     = require('joi');
const db      = require('../../config/database');
const logger  = require('../utils/logger');
const { requireAuth, requireRole, auditLog } = require('../middleware/auth');

// ─── Protect ALL attachment routes ────────────────────────────────────────────
router.use(requireAuth);

// ─── Validation schemas ───────────────────────────────────────────────────────
const createSchema = Joi.object({
  pole_id:            Joi.number().integer().required(),
  sensor_type:        Joi.string().max(60).required(),
  manufacturer_id:    Joi.string().max(80).optional().allow('', null),
  model_number:       Joi.string().max(80).optional().allow('', null),
  firmware_version:   Joi.string().max(30).optional().allow('', null),
  mac_address:        Joi.string().max(20).optional().allow('', null),
  commissioning_date: Joi.string().isoDate().optional().allow(null),
  config_json:        Joi.object().optional().allow(null),
});

const updateSchema = Joi.object({
  status:           Joi.string().valid(
    'ACTIVE','INACTIVE','FAULTY','DECOMMISSIONED'
  ).optional(),
  firmware_version: Joi.string().max(30).optional().allow('', null),
  config_json:      Joi.object().optional().allow(null),
});

// ─── GET /api/v1/attachments ──────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const limit       = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset      = parseInt(req.query.offset) || 0;
    const sensor_type = req.query.sensor_type;
    const status      = req.query.status;
    const pole_id     = req.query.pole_id;

    const conditions = [];
    const params     = [];
    let   idx        = 1;

    // EE sees only their zone
    if (req.user.role === 'GVMC_EE' && req.user.zone_id) {
      conditions.push(`w.zone_id = $${idx++}`);
      params.push(req.user.zone_id);
    }

    if (sensor_type) {
      conditions.push(`a.sensor_type = $${idx++}`);
      params.push(sensor_type);
    }
    if (status) {
      conditions.push(`a.status = $${idx++}`);
      params.push(status);
    }
    if (pole_id) {
      conditions.push(`a.pole_id = $${idx++}`);
      params.push(parseInt(pole_id));
    }

    const whereClause = conditions.length
      ? 'WHERE ' + conditions.join(' AND ')
      : '';

    params.push(limit, offset);

    const rows = await db.manyOrNone(`
      SELECT a.attachment_id, a.pole_id, a.sensor_type,
             a.manufacturer_id, a.model_number, a.firmware_version,
             a.mac_address, a.commissioning_date, a.status,
             a.config_json, a.created_at, a.updated_at,
             p.pole_number,
             z.zone_name, w.ward_number
      FROM smart_city_attachments a
      JOIN poles p ON a.pole_id = p.pole_id
      JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id
      JOIN wards w ON jb.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      ${whereClause}
      ORDER BY a.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, params);

    res.json({ ok: true, count: rows.length, data: rows });
  } catch (err) {
    logger.error('Get attachments error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── GET /api/v1/attachments/pole/:pole_id ────────────────────────────────────
router.get('/pole/:pole_id', async (req, res) => {
  try {
    const rows = await db.manyOrNone(`
      SELECT a.*,
             p.pole_number,
             z.zone_name, w.ward_number
      FROM smart_city_attachments a
      JOIN poles p ON a.pole_id = p.pole_id
      JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id
      JOIN wards w ON jb.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      WHERE a.pole_id = $1
      ORDER BY a.sensor_type
    `, [parseInt(req.params.pole_id)]);

    res.json({ ok: true, count: rows.length, data: rows });
  } catch (err) {
    logger.error('Get pole attachments error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── GET /api/v1/attachments/:id ─────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const row = await db.oneOrNone(`
      SELECT a.*,
             p.pole_number,
             z.zone_name, w.ward_number,
             w.ward_amenity_sec_name
      FROM smart_city_attachments a
      JOIN poles p ON a.pole_id = p.pole_id
      JOIN junction_boxes jb ON p.cabinet_id = jb.cabinet_id
      JOIN wards w ON jb.ward_id = w.ward_id
      JOIN zones z ON w.zone_id = z.zone_id
      WHERE a.attachment_id = $1
    `, [parseInt(req.params.id)]);

    if (!row) {
      return res.status(404).json({ ok: false, error: 'Attachment not found' });
    }

    res.json({ ok: true, data: row });
  } catch (err) {
    logger.error('Get attachment error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── POST /api/v1/attachments ─────────────────────────────────────────────────
router.post('/',
  requireRole('SUPER_ADMIN', 'GVMC_COMMISSIONER', 'GVMC_EE'),
  async (req, res) => {
    const { error, value } = createSchema.validate(req.body);
    if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

    try {
      // Verify pole exists
      const pole = await db.oneOrNone(
        'SELECT pole_id FROM poles WHERE pole_id = $1', [value.pole_id]
      );
      if (!pole) {
        return res.status(404).json({ ok: false, error: 'Pole not found' });
      }

      // Check MAC address uniqueness if provided
      if (value.mac_address) {
        const existing = await db.oneOrNone(
          'SELECT attachment_id FROM smart_city_attachments WHERE mac_address = $1',
          [value.mac_address]
        );
        if (existing) {
          return res.status(409).json({
            ok: false, error: 'MAC address already registered'
          });
        }
      }

      const attachment = await db.one(`
        INSERT INTO smart_city_attachments
          (pole_id, sensor_type, manufacturer_id, model_number,
           firmware_version, mac_address, commissioning_date, config_json)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING attachment_id, pole_id, sensor_type, status, created_at
      `, [
        value.pole_id,
        value.sensor_type,
        value.manufacturer_id  || null,
        value.model_number     || null,
        value.firmware_version || null,
        value.mac_address      || null,
        value.commissioning_date || null,
        value.config_json ? JSON.stringify(value.config_json) : null,
      ]);

      await auditLog(req.user.user_id, 'ATTACHMENT_CREATED', 'smart_city_attachments',
        attachment.attachment_id, true,
        { pole_id: value.pole_id, sensor_type: value.sensor_type }, req);

      logger.info('Attachment created', {
        attachment_id: attachment.attachment_id,
        by: req.user.user_id
      });

      res.status(201).json({ ok: true, data: attachment });
    } catch (err) {
      logger.error('Create attachment error', { error: err.message });
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  }
);

// ─── PATCH /api/v1/attachments/:id ───────────────────────────────────────────
router.patch('/:id',
  requireRole('SUPER_ADMIN', 'GVMC_COMMISSIONER', 'GVMC_EE'),
  async (req, res) => {
    const { error, value } = updateSchema.validate(req.body);
    if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

    try {
      const existing = await db.oneOrNone(
        'SELECT attachment_id FROM smart_city_attachments WHERE attachment_id = $1',
        [parseInt(req.params.id)]
      );
      if (!existing) {
        return res.status(404).json({ ok: false, error: 'Attachment not found' });
      }

      const updates = [];
      const params  = [];
      let   idx     = 1;

      if (value.status) {
        updates.push(`status = $${idx++}`);
        params.push(value.status);
      }
      if (value.firmware_version !== undefined) {
        updates.push(`firmware_version = $${idx++}`);
        params.push(value.firmware_version);
      }
      if (value.config_json !== undefined) {
        updates.push(`config_json = $${idx++}`);
        params.push(JSON.stringify(value.config_json));
      }

      if (!updates.length) {
        return res.status(400).json({ ok: false, error: 'No fields to update' });
      }

      params.push(parseInt(req.params.id));
      await db.none(
        `UPDATE smart_city_attachments SET ${updates.join(', ')}
         WHERE attachment_id = $${idx}`,
        params
      );

      await auditLog(req.user.user_id, 'ATTACHMENT_UPDATED',
        'smart_city_attachments', parseInt(req.params.id),
        true, { changes: value }, req);

      res.json({ ok: true, message: 'Attachment updated successfully' });
    } catch (err) {
      logger.error('Update attachment error', { error: err.message });
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  }
);

// ─── DELETE /api/v1/attachments/:id — Decommission only ──────────────────────
router.delete('/:id',
  requireRole('SUPER_ADMIN', 'GVMC_COMMISSIONER'),
  async (req, res) => {
    try {
      const existing = await db.oneOrNone(
        `SELECT attachment_id, sensor_type, status
         FROM smart_city_attachments WHERE attachment_id = $1`,
        [parseInt(req.params.id)]
      );
      if (!existing) {
        return res.status(404).json({ ok: false, error: 'Attachment not found' });
      }
      if (existing.status === 'DECOMMISSIONED') {
        return res.status(400).json({ ok: false, error: 'Already decommissioned' });
      }

      // Soft delete only
      await db.none(
        `UPDATE smart_city_attachments SET status = 'DECOMMISSIONED'
         WHERE attachment_id = $1`,
        [parseInt(req.params.id)]
      );

      await auditLog(req.user.user_id, 'ATTACHMENT_DECOMMISSIONED',
        'smart_city_attachments', parseInt(req.params.id),
        true, { sensor_type: existing.sensor_type }, req);

      res.json({ ok: true, message: 'Attachment decommissioned' });
    } catch (err) {
      logger.error('Decommission attachment error', { error: err.message });
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  }
);

// ─── GET /api/v1/attachments/types/summary ───────────────────────────────────
router.get('/types/summary',
  requireRole('SUPER_ADMIN', 'GVMC_COMMISSIONER', 'GVMC_EE'),
  async (req, res) => {
    try {
      const summary = await db.manyOrNone(`
        SELECT sensor_type,
               COUNT(*) AS total,
               COUNT(*) FILTER(WHERE status='ACTIVE') AS active,
               COUNT(*) FILTER(WHERE status='FAULTY') AS faulty,
               COUNT(*) FILTER(WHERE status='INACTIVE') AS inactive
        FROM smart_city_attachments
        GROUP BY sensor_type
        ORDER BY total DESC
      `);
      res.json({ ok: true, data: summary });
    } catch (err) {
      logger.error('Attachment summary error', { error: err.message });
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  }
);

module.exports = router;