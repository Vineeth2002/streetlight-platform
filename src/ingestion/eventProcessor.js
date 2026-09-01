'use strict';

const db = require('../../config/database');
const logger = require('../utils/logger');
const { normalizeIncomingEvent } = require('./normalizer');
const { resolveAsset } = require('./asset-resolver');
const { correlateEvent } = require('../services/incidentCorrelator');
const { broadcastNodeTelemetry, broadcastAlert } = require('../websocket/wsServer');

async function processIncomingEvent(input) {
  const event = normalizeIncomingEvent(input);
  const resolution = await resolveAsset(event);

  if (!resolution.asset_id) {
    logger.warn('Ingestion event could not be resolved to an asset', {
      source: event.source,
      source_device_id: event.source_device_id,
      correlation_id: event.correlation_id,
    });
    return { accepted: false, reason: 'ASSET_UNRESOLVED', event, resolution };
  }

  const data = event.data || {};
  const poleNumber = resolution.pole_number || data.pole_number || event.source_device_id;

  // Persist the canonical event first. This is the immutable operational record
  // that can later be tied to incidents, work orders, alerts and audit history.
  const storedEvent = await db.one(`
    INSERT INTO ingestion_events
      (event_type, source, source_device_id, asset_id, observed_at,
       received_at, data, quality, correlation_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING event_id
  `, [
    event.event_type,
    event.source,
    event.source_device_id,
    resolution.asset_id,
    event.observed_at,
    event.received_at,
    JSON.stringify(data),
    JSON.stringify(event.quality),
    event.correlation_id || null,
  ]);
  event.event_id = storedEvent.event_id;

  const hasTelemetry = [
    data.voltage_rms,
    data.current_rms,
    data.active_power,
    data.cabinet_on,
  ].every(value => value !== undefined && value !== null);

  if (hasTelemetry) {
    await db.none(`
      INSERT INTO node_telemetry
        (timestamp, pole_number, node_id, voltage_rms, current_rms,
         active_power, power_factor, temperature, rssi)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [
      event.observed_at,
      poleNumber,
      resolution.node_id || event.source_device_id || null,
      data.voltage_rms,
      data.current_rms,
      data.active_power,
      data.power_factor ?? 0.9,
      data.temperature ?? null,
      data.rssi ?? null,
    ]);
  }

  const incident = await correlateEvent(event, resolution);

  if (event.event_type === 'TELEMETRY' || event.event_type === 'STATE_CHANGE') {
    broadcastNodeTelemetry(poleNumber, data, {
      asset_id: resolution.asset_id,
      source: event.source,
      observed_at: event.observed_at,
      quality: event.quality,
      incident,
    });
  }

  if (event.event_type === 'FAULT' || event.event_type === 'ALARM' || incident.action === 'CREATED') {
    broadcastAlert('FAULT_EVENT', {
      asset_id: resolution.asset_id,
      pole_number: poleNumber,
      source: event.source,
      observed_at: event.observed_at,
      data,
      quality: event.quality,
      incident,
    });
  }

  return {
    accepted: true,
    event_id: event.event_id,
    persisted_telemetry: hasTelemetry,
    incident,
    event,
    resolution,
  };
}

module.exports = { processIncomingEvent };
