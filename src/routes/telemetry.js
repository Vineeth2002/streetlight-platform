const express = require('express');
const router  = express.Router();
const Joi     = require('joi');
const db      = require('../../config/database');
const logger  = require('../utils/logger');
const { diagnose, createAutoWorkOrder } = require('../services/diagnosticEngine');
const { broadcastNodeTelemetry, broadcastAlert } = require('../websocket/wsServer');
const { requireAuth, requireRole, auditLog } = require('../middleware/auth');

// ─── Validation schemas ───────────────────────────────────────────────────────
const nodeReadingSchema = Joi.object({
  pole_number:  Joi.string().max(30).required(),
  node_id:      Joi.string().max(50).optional().allow('', null),
  voltage_rms:  Joi.number().min(0).max(300).required(),
  current_rms:  Joi.number().min(0).max(100).required(),
  active_power: Joi.number().min(0).required(),
  power_factor: Joi.number().min(0).max(1).optional().default(0.9),
  temperature:  Joi.number().min(-20).max(100).optional().allow(null),
  rssi:         Joi.number().optional().allow(null),
  cabinet_on:   Joi.boolean().required(),
});

const attachmentSchema = Joi.object({
  attachment_id:     Joi.number().integer().required(),
  raw_data_payload:  Joi.object().required(),
  ingest_latency_ms: Joi.number().integer().optional().allow(null),
});

// ─── POST /api/v1/telemetry/node ─────────────────────────────────────────────
// Accepts telemetry from CCMS nodes
// Uses API key OR JWT token for auth
router.post('/node', async (req, res) => {
  // Check API key first (for IoT devices)
  const apiKey = req.headers['x-api-key'];
  let authorized = false;

  if (apiKey) {
    try {
      const crypto = require('crypto');
      const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
      const key = await db.oneOrNone(
        `SELECT key_id, role FROM api_keys
         WHERE key_hash = $1 AND is_active = true
           AND (expires_at IS NULL OR expires_at > NOW())`,
        [keyHash]
      );
      if (key) {
        authorized = true;
        // Update last used
        await db.none(
          'UPDATE api_keys SET last_used = NOW() WHERE key_id = $1',
          [key.key_id]
        );
      }
    } catch (err) {
      logger.error('API key check failed', { error: err.message });
    }
  }

  // Fall back to JWT token
  if (!authorized) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const jwt = require('jsonwebtoken');
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded) authorized = true;
      } catch (err) {
        // Invalid token
      }
    }
  }

  if (!authorized) {
    return res.status(401).json({ ok: false, error: 'Unauthorized — provide API key or JWT token' });
  }

  // Validate input
  const { error, value } = nodeReadingSchema.validate(req.body);
  if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

  try {
    // Look up pole
    const pole = await db.oneOrNone(
      `SELECT p.pole_id, p.pole_number, p.luminaire_wattage,
              p.wiring_type, p.current_status, p.node_id
       FROM poles p WHERE p.pole_number = $1`,
      [value.pole_number]
    );

    // Save telemetry regardless of pole existence
    await db.none(`
      INSERT INTO node_telemetry
        (timestamp, pole_number, node_id, voltage_rms, current_rms,
         active_power, power_factor, temperature, rssi)
      VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      value.pole_number,
      value.node_id || (pole?.node_id) || null,
      value.voltage_rms,
      value.current_rms,
      value.active_power,
      value.power_factor,
      value.temperature || null,
      value.rssi || null,
    ]);

    // Run diagnostics only if pole exists in DB
    let diagnosis = null;
    let workOrder = null;

    if (pole) {
      diagnosis = await diagnose({
        poleNumber:  value.pole_number,
        voltageRms:  value.voltage_rms,
        currentRms:  value.current_rms,
        activePower: value.active_power,
        powerFactor: value.power_factor,
        cabinetOn:   value.cabinet_on,
        wiringType:  pole.wiring_type,
      });

      // Auto create work order only for recommendations that warrant one —
      // this still auto-creates a TICKET, but the ticket now carries a
      // confidence score and multiple possible causes for a human to
      // review, rather than stating a single fault as settled fact.
      if (diagnosis.createWorkOrder && pole.pole_id) {
        try {
          workOrder = await createAutoWorkOrder(
            pole.pole_id,
            diagnosis,
            diagnosis.message
          );
        } catch (woErr) {
          logger.error('Work order creation failed', { error: woErr.message });
        }
      }

      // Broadcast to WebSocket clients
      broadcastNodeTelemetry(value.pole_number, value, diagnosis);

      // Broadcast alert for critical faults
      if (diagnosis.severity === 'CRITICAL') {
        broadcastAlert('FAULT_CRITICAL', {
          pole_number:      value.pole_number,
          recommended_fault: diagnosis.recommendedFault,
          confidence_pct:    diagnosis.confidencePct,
          message:           diagnosis.message,
        });
      }
    }

    res.json({
      ok:        true,
      pole_found: !!pole,
      diagnosis,
      work_order: workOrder,
    });

  } catch (err) {
    logger.error('Telemetry ingest error', { error: err.message, pole: value.pole_number });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── POST /api/v1/telemetry/attachment ───────────────────────────────────────
router.post('/attachment', async (req, res) => {
  // Same auth as node telemetry
  const apiKey = req.headers['x-api-key'];
  const authHeader = req.headers.authorization;
  let authorized = false;

  if (apiKey) {
    try {
      const crypto = require('crypto');
      const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
      const key = await db.oneOrNone(
        `SELECT key_id FROM api_keys
         WHERE key_hash = $1 AND is_active = true
           AND (expires_at IS NULL OR expires_at > NOW())`,
        [keyHash]
      );
      if (key) authorized = true;
    } catch (err) {}
  }

  if (!authorized && authHeader?.startsWith('Bearer ')) {
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(
        authHeader.split(' ')[1],
        process.env.JWT_SECRET
      );
      if (decoded) authorized = true;
    } catch (err) {}
  }

  if (!authorized) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const { error, value } = attachmentSchema.validate(req.body);
  if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

  try {
    const attachment = await db.oneOrNone(
      `SELECT attachment_id, sensor_type FROM smart_city_attachments
       WHERE attachment_id = $1 AND status = 'ACTIVE'`,
      [value.attachment_id]
    );

    if (!attachment) {
      return res.status(404).json({
        ok: false,
        error: 'Attachment not found or inactive'
      });
    }

    await db.none(`
      INSERT INTO attachment_telemetry
        (timestamp, attachment_id, raw_data_payload, ingest_latency_ms)
      VALUES (NOW(), $1, $2, $3)
    `, [
      value.attachment_id,
      JSON.stringify(value.raw_data_payload),
      value.ingest_latency_ms || null,
    ]);

    const { broadcastAttachmentTelemetry } = require('../websocket/wsServer');
    broadcastAttachmentTelemetry(
      attachment.sensor_type,
      value.attachment_id,
      value.raw_data_payload
    );

    res.json({ ok: true, attachment_id: value.attachment_id });

  } catch (err) {
    logger.error('Attachment telemetry error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── GET /api/v1/telemetry/node/:pole_number ─────────────────────────────────
// Get recent telemetry for a pole — requires JWT auth
router.get('/node/:pole_number', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);

    const rows = await db.manyOrNone(`
      SELECT timestamp, pole_number, node_id,
             voltage_rms, current_rms, active_power,
             power_factor, temperature, rssi
      FROM node_telemetry
      WHERE pole_number = $1
      ORDER BY timestamp DESC
      LIMIT $2
    `, [req.params.pole_number, limit]);

    res.json({ ok: true, count: rows.length, data: rows });
  } catch (err) {
    logger.error('Get telemetry error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ─── GET /api/v1/telemetry/stats ─────────────────────────────────────────────
// Telemetry ingestion stats — admin only
router.get('/stats',
  requireAuth,
  requireRole('SUPER_ADMIN', 'GVMC_COMMISSIONER', 'GVMC_EE'),
  async (req, res) => {
    try {
      const stats = await db.oneOrNone(`
        SELECT
          COUNT(*) AS total_readings,
          COUNT(DISTINCT pole_number) AS unique_poles,
          MIN(timestamp) AS oldest_reading,
          MAX(timestamp) AS latest_reading,
          AVG(voltage_rms)::NUMERIC(7,2) AS avg_voltage,
          AVG(current_rms)::NUMERIC(7,4) AS avg_current
        FROM node_telemetry
        WHERE timestamp >= NOW() - INTERVAL '24 hours'
      `);

      res.json({ ok: true, last_24_hours: stats });
    } catch (err) {
      logger.error('Telemetry stats error', { error: err.message });
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  }
);

module.exports = router;