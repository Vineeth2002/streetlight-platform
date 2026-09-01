const express = require('express');
const router  = express.Router();
const Joi     = require('joi');
const db      = require('../../config/database');
const logger  = require('../utils/logger');
const { diagnose, createAutoWorkOrder } = require('../services/diagnosticEngine');
const { applyTelemetryState } = require('../services/assetStateService');
const { recordFault, recordRecovery, attachWorkOrder } = require('../services/faultLifecycleService');
const { broadcastNodeTelemetry, broadcastAlert } = require('../websocket/wsServer');
const { normalizeIncomingEvent } = require('../ingestion/normalizer');
const { processCanonicalEvent } = require('../ingestion/eventProcessor');

const nodeReadingSchema = Joi.object({
  pole_number: Joi.string().max(30).required(), node_id: Joi.string().max(50).optional().allow('', null),
  voltage_rms: Joi.number().min(0).max(300).required(), current_rms: Joi.number().min(0).max(100).required(),
  active_power: Joi.number().min(0).required(), power_factor: Joi.number().min(0).max(1).optional().default(0.9),
  temperature: Joi.number().min(-20).max(100).optional().allow(null), rssi: Joi.number().optional().allow(null),
  cabinet_on: Joi.boolean().required(), observed_at: Joi.date().iso().optional(),
  source: Joi.string().valid('CCMS','IOT','FIELD','CITIZEN','SYSTEM','DEMO').optional(),
  event_type: Joi.string().valid('TELEMETRY','FAULT','STATE_CHANGE','HEARTBEAT','ALARM').optional()
});

const attachmentSchema = Joi.object({ attachment_id: Joi.number().integer().required(), raw_data_payload: Joi.object().required(), ingest_latency_ms: Joi.number().integer().optional().allow(null) });

async function authenticateTelemetry(req) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    try {
      const crypto = require('crypto');
      const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
      const key = await db.oneOrNone(`SELECT key_id, role FROM api_keys WHERE key_hash=$1 AND is_active=true AND (expires_at IS NULL OR expires_at>NOW())`, [keyHash]);
      if (key) { await db.none('UPDATE api_keys SET last_used=NOW() WHERE key_id=$1', [key.key_id]); return true; }
    } catch (err) { logger.error('API key check failed', { error: err.message }); }
  }
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try { require('jsonwebtoken').verify(authHeader.split(' ')[1], process.env.JWT_SECRET || 'change_this_in_production'); return true; }
    catch { return false; }
  }
  return false;
}

router.post('/node', async (req, res) => {
  if (!(await authenticateTelemetry(req))) return res.status(401).json({ ok:false, error:'Unauthorized — provide API key or JWT token' });
  const { error, value } = nodeReadingSchema.validate(req.body);
  if (error) return res.status(400).json({ ok:false, error:error.details[0].message });

  try {
    const observedAt = value.observed_at || new Date().toISOString();
    const canonicalEvent = normalizeIncomingEvent({ event_type:value.event_type || 'TELEMETRY', source:value.source || 'CCMS', source_device_id:value.node_id || value.pole_number, asset_id:null, observed_at:observedAt,
      data:{ pole_number:value.pole_number, node_id:value.node_id || null, voltage_rms:value.voltage_rms, current_rms:value.current_rms, active_power:value.active_power, power_factor:value.power_factor, temperature:value.temperature ?? null, rssi:value.rssi ?? null, cabinet_on:value.cabinet_on } });
    const ingestion = await processCanonicalEvent(canonicalEvent);

    const pole = await db.oneOrNone(`SELECT pole_id,pole_number,luminaire_wattage,wiring_type,current_status,node_id FROM poles WHERE pole_number=$1`, [value.pole_number]);
    let diagnosis = null; let workOrder = null; let stateTransition = null; let lifecycle = null;
    if (pole) {
      diagnosis = await diagnose({ poleNumber:value.pole_number, voltageRms:value.voltage_rms, currentRms:value.current_rms, activePower:value.active_power, powerFactor:value.power_factor, cabinetOn:value.cabinet_on, wiringType:pole.wiring_type });

      const healthy = diagnosis.severity === 'NORMAL' && value.cabinet_on === true;
      stateTransition = await applyTelemetryState({ poleNumber:value.pole_number, healthy, signalPresent:true, source:value.source || 'CCMS', observedAt });

      if (healthy) {
        lifecycle = { recovered: await recordRecovery({ pole, observedAt }) };
      } else if (diagnosis.createWorkOrder && pole.pole_id) {
        lifecycle = await recordFault({ pole, diagnosis, observedAt, source:value.source || 'TELEMETRY' });
        try {
          workOrder = await createAutoWorkOrder(pole.pole_id, diagnosis, diagnosis.message);
          if (workOrder?.work_order_id && lifecycle?.episode?.episode_id) {
            lifecycle.episode = await attachWorkOrder({ episodeId:lifecycle.episode.episode_id, workOrderId:workOrder.work_order_id });
          }
        } catch (woErr) { logger.error('Work order creation failed', { error:woErr.message }); }
      }
      broadcastNodeTelemetry(value.pole_number, value, diagnosis);
      if (diagnosis.severity === 'CRITICAL') broadcastAlert('FAULT_CRITICAL', { pole_number:value.pole_number, recommended_fault:diagnosis.recommendedFault, confidence_pct:diagnosis.confidencePct, message:diagnosis.message });
    }

    res.json({ ok:true, pole_found:!!pole, ingestion, diagnosis, state_transition:stateTransition, lifecycle, work_order:workOrder });
  } catch (err) {
    logger.error('Telemetry ingest error', { error:err.message, pole:value.pole_number });
    res.status(err.status || 500).json({ ok:false, error:err.status ? err.message : 'Internal server error' });
  }
});

router.post('/attachment', async (req,res) => {
  if (!(await authenticateTelemetry(req))) return res.status(401).json({ok:false,error:'Unauthorized'});
  const {error,value}=attachmentSchema.validate(req.body); if(error)return res.status(400).json({ok:false,error:error.details[0].message});
  try {
    const attachment=await db.oneOrNone(`SELECT attachment_id,sensor_type FROM smart_city_attachments WHERE attachment_id=$1 AND status='ACTIVE'`,[value.attachment_id]);
    if(!attachment)return res.status(404).json({ok:false,error:'Attachment not found or inactive'});
    await db.none(`INSERT INTO attachment_telemetry(timestamp,attachment_id,raw_data_payload,ingest_latency_ms) VALUES(NOW(),$1,$2,$3)`,[value.attachment_id,JSON.stringify(value.raw_data_payload),value.ingest_latency_ms||null]);
    const {broadcastAttachmentTelemetry}=require('../websocket/wsServer'); broadcastAttachmentTelemetry(attachment.sensor_type,value.attachment_id,value.raw_data_payload); res.json({ok:true,attachment_id:value.attachment_id});
  }catch(err){logger.error('Attachment telemetry error',{error:err.message});res.status(500).json({ok:false,error:'Internal server error'});}
});

module.exports=router;
