'use strict';

const db = require('../../config/database');
const logger = require('../utils/logger');
const { normalizeIncomingEvent } = require('./normalizer');
const { resolveAsset } = require('./asset-resolver');
const { broadcastNodeTelemetry, broadcastAlert } = require('../websocket/wsServer');

/**
 * Platform ingestion boundary.
 *
 * Adapters call processIncomingEvent(); they do not write to the dashboard.
 * The processor normalizes and resolves the event, persists telemetry using
 * the existing schema, and publishes the resulting observation to WebSocket.
 * Incident/diagnostic decisions remain in the existing domain services until
 * their contract is migrated deliberately.
 */
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

  // Persist only when the canonical event contains the measurements expected
  // by the existing node_telemetry table. This keeps unrelated event types
  // from being forced into a telemetry-shaped row.
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
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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

  if (event.event_type === 'TELEMETRY' || event.event_type === 'STATE_CHANGE') {
    broadcastNodeTelemetry(poleNumber, data, {
      asset_id: resolution.asset_id,
      source: event.source,
      observed_at: event.observed_at,
      quality: event.quality,
    });
  }

  if (event.event_type === 'FAULT' || event.event_type === 'ALARM') {
    broadcastAlert('FAULT_EVENT', {
      asset_id: resolution.asset_id,
      pole_number: poleNumber,
      source: event.source,
      observed_at: event.observed_at,
      data,
      quality: event.quality,
    });
  }

  return {
    accepted: true,
    persisted_telemetry: hasTelemetry,
    event,
    resolution,
  };
}

module.exports = { processIncomingEvent };
