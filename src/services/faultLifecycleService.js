'use strict';

const db = require('../../config/database');
const { openOrRefreshEpisode, markRecovered } = require('./faultEpisodeService');

function incidentNumber() {
  return `INC-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.floor(Math.random() * 900 + 100)}`;
}

async function recordFault({ pole, diagnosis, observedAt, source = 'TELEMETRY' }) {
  const category = diagnosis.recommendedFault || 'MANUAL_REPORT';

  return db.tx(async t => {
    // Find an existing active incident for the same asset and fault category.
    const existing = await t.oneOrNone(`
      SELECT i.*
      FROM incidents i
      JOIN fault_episodes f ON f.incident_id = i.incident_id
      WHERE f.pole_id = $1 AND f.fault_category = $2 AND f.status = 'OPEN'
      ORDER BY i.detected_at DESC
      LIMIT 1
      FOR UPDATE OF i`, [pole.pole_id, category]);

    let incident = existing;
    if (!incident) {
      incident = await t.one(`
        INSERT INTO incidents
          (incident_number, incident_type, severity, status, source,
           primary_asset_id, detected_at, summary, recommendation)
        VALUES ($1,$2,$3,'OPEN',$4,$5,$6,$7,$8)
        RETURNING *`, [
          incidentNumber(), category, diagnosis.severity || 'MEDIUM', source,
          pole.pole_id, observedAt,
          diagnosis.message || `Fault detected on ${pole.pole_number}`,
          diagnosis.recommendedFault || null
        ]);

      await t.none(`
        INSERT INTO incident_assets (incident_id, pole_id, relationship, first_seen_at, last_seen_at)
        VALUES ($1,$2,'PRIMARY',$3,$3)
        ON CONFLICT (incident_id,pole_id)
        DO UPDATE SET last_seen_at = GREATEST(incident_assets.last_seen_at, EXCLUDED.last_seen_at)`,
        [incident.incident_id, pole.pole_id, observedAt]);
    }

    return { incident, created: !existing };
  }).then(async result => {
    const episode = await openOrRefreshEpisode({
      poleId: pole.pole_id,
      faultCategory: category,
      observedAt,
      source,
      incidentId: result.incident.incident_id,
      metadata: {
        severity: diagnosis.severity,
        confidence_pct: diagnosis.confidencePct,
        model_version: diagnosis.modelVersion
      }
    });
    return { ...result, episode };
  });
}

async function recordRecovery({ pole, observedAt }) {
  const episodes = await db.manyOrNone(`
    SELECT episode_id, fault_category, incident_id
    FROM fault_episodes
    WHERE pole_id = $1 AND status = 'OPEN'`, [pole.pole_id]);

  const recovered = [];
  for (const episode of episodes) {
    const row = await markRecovered({ poleId: pole.pole_id, faultCategory: episode.fault_category, recoveredAt: observedAt });
    if (!row) continue;

    // Recovery is not final closure. A field/authorized verifier still owns closure.
    if (row.incident_id) {
      await db.none(`UPDATE incidents SET status='AWAITING_VERIFICATION', resolved_at=$2, updated_at=NOW() WHERE incident_id=$1 AND status NOT IN ('CLOSED','CANCELLED')`, [row.incident_id, observedAt]);
    }
    recovered.push(row);
  }
  return recovered;
}

module.exports = { recordFault, recordRecovery };
