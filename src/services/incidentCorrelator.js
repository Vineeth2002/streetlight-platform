'use strict';

const crypto = require('crypto');
const db = require('../../config/database');

function incidentNumber() {
  return `INC-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

/**
 * Correlates a normalized telemetry event into an operational incident.
 * This first version is intentionally conservative: it creates an incident
 * only for an explicit OFF/FAULT/ALARM event and reuses an open incident for
 * the same asset. Grouping across a cabinet/circuit will be added once the
 * source-to-circuit mapping is available.
 */
async function correlateEvent(event, resolvedAsset) {
  const assetId = resolvedAsset?.asset_id;
  if (!assetId) return { action: 'IGNORED', reason: 'UNRESOLVED_ASSET' };

  const data = event.data || {};
  const status = String(data.status || '').toUpperCase();
  const eventType = String(event.event_type || '').toUpperCase();
  const isFault = ['FAULT', 'ALARM'].includes(eventType) || status === 'OFF' || data.cabinet_on === false;

  if (!isFault) return { action: 'NO_INCIDENT', asset_id: assetId };

  const existing = await db.oneOrNone(
    `SELECT incident_id, incident_number, status
       FROM incidents
      WHERE primary_asset_id = $1
        AND status NOT IN ('RESOLVED','CLOSED','CANCELLED')
      ORDER BY detected_at DESC
      LIMIT 1`,
    [assetId]
  );

  if (existing) {
    await db.none(
      `INSERT INTO incident_events (incident_id, event_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [existing.incident_id, event.event_id]
    );
    await db.none(
      `UPDATE incidents SET updated_at = NOW() WHERE incident_id = $1`,
      [existing.incident_id]
    );
    return { action: 'UPDATED', incident_id: existing.incident_id, incident_number: existing.incident_number };
  }

  const severity = eventType === 'ALARM' || data.cabinet_on === false ? 'HIGH' : 'MEDIUM';
  const summary = data.message || `Streetlight fault detected for ${resolvedAsset.pole_number || assetId}`;

  const incident = await db.one(
    `INSERT INTO incidents
       (incident_number, incident_type, severity, status, source,
        primary_asset_id, detected_at, summary, recommendation)
     VALUES ($1, $2, $3, 'OPEN', $4, $5, $6, $7, $8)
     RETURNING incident_id, incident_number, status, severity`,
    [
      incidentNumber(),
      data.cabinet_on === false ? 'CABINET_OR_FEEDER_FAULT' : 'ASSET_FAULT',
      severity,
      event.source,
      assetId,
      event.observed_at,
      summary,
      'Field verification required before final diagnosis or contractor action.'
    ]
  );

  await db.none(
    `INSERT INTO incident_assets (incident_id, pole_id, relationship)
     VALUES ($1, $2, 'PRIMARY')
     ON CONFLICT DO NOTHING`,
    [incident.incident_id, assetId]
  );

  await db.none(
    `INSERT INTO incident_events (incident_id, event_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [incident.incident_id, event.event_id]
  );

  return { action: 'CREATED', ...incident };
}

module.exports = { correlateEvent };
