'use strict';

const db = require('../../config/database');

/**
 * Groups simultaneous asset faults under the existing cabinet relationship.
 * This is deliberately conservative: a cabinet group is only formed when
 * multiple poles on the same cabinet report faults within the correlation
 * window. It does not claim a circuit fault without circuit telemetry.
 */
async function correlateCabinetIncident({ poleId, observedAt, windowSeconds = 90 }) {
  const pole = await db.oneOrNone(
    `SELECT cabinet_id FROM poles WHERE pole_id = $1`, [poleId]
  );
  if (!pole) return { grouped: false, reason: 'ASSET_NOT_FOUND' };

  const affected = await db.any(
    `SELECT DISTINCT p.pole_id
       FROM poles p
       JOIN ingestion_events e ON e.asset_id = p.pole_id
      WHERE p.cabinet_id = $1
        AND e.observed_at BETWEEN ($2::timestamptz - ($3 || ' seconds')::interval) AND ($2::timestamptz + ($3 || ' seconds')::interval)
        AND (
          UPPER(COALESCE(e.data->>'status','')) = 'OFF'
          OR UPPER(e.event_type) IN ('FAULT','ALARM')
          OR COALESCE((e.data->>'cabinet_on')::boolean, true) = false
        )`,
    [pole.cabinet_id, observedAt, windowSeconds]
  );

  if (affected.length < 2) return { grouped: false, cabinet_id: pole.cabinet_id, affected_count: affected.length };

  const group = await db.tx(async t => {
    const existing = await t.oneOrNone(
      `SELECT group_id FROM incident_groups
        WHERE cabinet_id = $1 AND status = 'OPEN'
        ORDER BY last_detected DESC LIMIT 1 FOR UPDATE`, [pole.cabinet_id]
    );

    const groupRow = existing
      ? await t.one(`UPDATE incident_groups SET last_detected = $1, affected_count = $2 WHERE group_id = $3 RETURNING *`, [observedAt, affected.length, existing.group_id])
      : await t.one(`INSERT INTO incident_groups (group_type,cabinet_id,last_detected,affected_count) VALUES ('CABINET',$1,$2,$3) RETURNING *`, [pole.cabinet_id, observedAt, affected.length]);

    for (const asset of affected) {
      await t.none(
        `INSERT INTO incident_group_assets (group_id,pole_id,observed_at,reason)
         VALUES ($1,$2,$3,'SIMULTANEOUS_CABINET_FAULT') ON CONFLICT (group_id,pole_id) DO UPDATE SET observed_at = EXCLUDED.observed_at`,
        [groupRow.group_id, asset.pole_id, observedAt]
      );
    }

    return groupRow;
  });

  return { grouped: true, ...group, affected_assets: affected.map(a => a.pole_id) };
}

module.exports = { correlateCabinetIncident };
