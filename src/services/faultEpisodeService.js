'use strict';

const db = require('../../config/database');

async function openOrRefreshEpisode({ poleId, faultCategory, observedAt, source = 'TELEMETRY', incidentId = null, workOrderId = null, metadata = {} }) {
  if (!poleId || !faultCategory) throw new Error('poleId and faultCategory are required');

  return db.tx(async t => {
    const existing = await t.oneOrNone(
      `SELECT * FROM fault_episodes
        WHERE pole_id = $1 AND fault_category = $2 AND status = 'OPEN'
        FOR UPDATE`,
      [poleId, faultCategory]
    );

    if (existing) {
      const refreshed = await t.one(
        `UPDATE fault_episodes
            SET last_observed_at = GREATEST(last_observed_at, $2::timestamptz),
                incident_id = COALESCE(incident_id, $3),
                work_order_id = COALESCE(work_order_id, $4),
                metadata = metadata || $5::jsonb,
                updated_at = NOW()
          WHERE episode_id = $1
        RETURNING *`,
        [existing.episode_id, observedAt, incidentId, workOrderId, JSON.stringify(metadata)]
      );
      return { created: false, episode: refreshed };
    }

    const created = await t.one(
      `INSERT INTO fault_episodes
        (pole_id, fault_category, first_detected_at, last_observed_at, incident_id, work_order_id, detection_source, metadata)
       VALUES ($1,$2,$3,$3,$4,$5,$6,$7)
       RETURNING *`,
      [poleId, faultCategory, observedAt, incidentId, workOrderId, source, JSON.stringify(metadata)]
    );
    return { created: true, episode: created };
  });
}

async function markRecovered({ poleId, faultCategory, recoveredAt, metadata = {} }) {
  const row = await db.oneOrNone(
    `UPDATE fault_episodes
        SET status = 'RECOVERED', recovered_at = $3::timestamptz,
            last_observed_at = GREATEST(last_observed_at, $3::timestamptz),
            metadata = metadata || $4::jsonb, updated_at = NOW()
      WHERE pole_id = $1 AND fault_category = $2 AND status = 'OPEN'
    RETURNING *`,
    [poleId, faultCategory, recoveredAt, JSON.stringify(metadata)]
  );
  return row;
}

module.exports = { openOrRefreshEpisode, markRecovered };
