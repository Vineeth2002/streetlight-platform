const express = require('express');
const Joi     = require('joi');
const router  = express.Router();
const db      = require('../../config/database');
const logger  = require('../utils/logger');
const { diagnose, createAutoWorkOrder } = require('../services/diagnosticEngine');
const { sendModbusCommand }             = require('../services/modbusService');
const ws                                = require('../websocket/wsServer');

const nodeTelemetrySchema = Joi.object({
  pole_number:  Joi.string().max(30).required(),
  node_id:      Joi.string().max(50).optional(),
  voltage_rms:  Joi.number().min(0).max(300).required(),
  current_rms:  Joi.number().min(0).max(100).required(),
  active_power: Joi.number().min(0).optional(),
  power_factor: Joi.number().min(0).max(1).optional(),
  temperature:  Joi.number().min(-10).max(100).optional(),
  rssi:         Joi.number().integer().min(-120).max(0).optional(),
  cabinet_on:   Joi.boolean().required(),
});

const attachmentSchema = Joi.object({
  attachment_id: Joi.number().integer().positive().required(),
  payload:       Joi.object().required(),
});

router.post('/node', async (req, res) => {
  const { error, value } = nodeTelemetrySchema.validate(req.body);
  if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

  try {
    await db.none(`
      INSERT INTO node_telemetry
        (timestamp, pole_number, node_id, voltage_rms, current_rms, active_power, power_factor, temperature, rssi)
      VALUES (NOW(),$1,$2,$3,$4,$5,$6,$7,$8)
    `, [value.pole_number, value.node_id||null, value.voltage_rms, value.current_rms,
        value.active_power||null, value.power_factor||null, value.temperature||null, value.rssi||null]);

    const poleData = await db.oneOrNone(`
      SELECT p.pole_id, p.pole_number, p.wiring_type, p.luminaire_wattage, jb.contactor_status
      FROM poles p JOIN junction_boxes jb ON p.cabinet_id=jb.cabinet_id
      WHERE p.pole_number=$1
    `, [value.pole_number]);

    let diagnosis = null;
    if (poleData) {
      diagnosis = diagnose({
        poleNumber: value.pole_number, voltageRms: value.voltage_rms,
        currentRms: value.current_rms, activePower: value.active_power,
        powerFactor: value.power_factor,
        cabinetOn: poleData.contactor_status === 'ON',
        wiringType: poleData.wiring_type,
      });
      if (diagnosis.createWorkOrder) {
        await createAutoWorkOrder(poleData.pole_id, diagnosis.faultCategory, diagnosis.message);
      }
    }

    ws.broadcastNodeTelemetry(value.pole_number, value, diagnosis);
    res.status(201).json({ ok: true, pole: value.pole_number, diagnosis });
  } catch (err) {
    logger.error('Node telemetry error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.post('/attachment', async (req, res) => {
  const { error, value } = attachmentSchema.validate(req.body);
  if (error) return res.status(400).json({ ok: false, error: error.details[0].message });

  const { attachment_id, payload } = value;

  try {
    const attachment = await db.oneOrNone(`
      SELECT a.attachment_id, a.sensor_type, a.status, a.pole_id, p.pole_number
      FROM smart_city_attachments a JOIN poles p ON a.pole_id=p.pole_id
      WHERE a.attachment_id=$1
    `, [attachment_id]);

    if (!attachment) return res.status(404).json({ ok: false, error: `Attachment ${attachment_id} not registered` });
    if (attachment.status !== 'ACTIVE') return res.status(409).json({ ok: false, error: `Attachment is ${attachment.status}` });

    await db.none(`
      INSERT INTO attachment_telemetry (timestamp, attachment_id, raw_data_payload)
      VALUES (NOW(),$1,$2::jsonb)
    `, [attachment_id, JSON.stringify(payload)]);

    ws.broadcastAttachmentTelemetry(attachment.sensor_type, attachment_id, payload);

    let modbusResult = null;
    if (payload.alarm === true || payload.priority === 'CRITICAL') {
      logger.warn('High-priority alarm — Modbus override', { attachment_id });
      try { modbusResult = await sendModbusCommand(attachment.pole_id, 'OVERRIDE_DIM_100'); }
      catch (e) { logger.error('Modbus override failed', { error: e.message }); }
      ws.broadcastAlert('SENSOR_ALARM', { attachment_id, sensor_type: attachment.sensor_type, pole_number: attachment.pole_number });
    }

    res.status(201).json({ ok: true, attachment_id, sensor_type: attachment.sensor_type, routed_to_ws: attachment.sensor_type, modbus_override: modbusResult });
  } catch (err) {
    logger.error('Attachment telemetry error', { error: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.get('/node/:poleNumber', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 60, 1440);
  try {
    const rows = await db.manyOrNone(`
      SELECT timestamp, voltage_rms, current_rms, active_power, power_factor, temperature, rssi
      FROM node_telemetry WHERE pole_number=$1 ORDER BY timestamp DESC LIMIT $2
    `, [req.params.poleNumber, limit]);
    res.json({ ok: true, pole_number: req.params.poleNumber, count: rows.length, readings: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

router.get('/ws-stats', (req, res) => res.json({ ok: true, websocket: ws.getStats() }));

module.exports = router;