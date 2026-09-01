'use strict';

const db = require('../../config/database');

// Reconciliation is deliberately conservative: a missing packet does not prove
// a lamp is physically OFF. It only proves that the platform has lost recent signal.
async function reconcileStaleNodes({ staleMinutes = 15, limit = 5000 } = {}) {
  const rows = await db.manyOrNone(
    `SELECT p.pole_id, p.pole_number, p.current_status, MAX(t.timestamp) AS last_telemetry_at
       FROM poles p
       LEFT JOIN node_telemetry t ON t.pole_number = p.pole_number
      WHERE p.node_id IS NOT NULL
      GROUP BY p.pole_id, p.pole_number, p.current_status
      HAVING MAX(t.timestamp) IS NULL
          OR MAX(t.timestamp) < NOW() - ($1::text || ' minutes')::interval
      ORDER BY last_telemetry_at NULLS FIRST
      LIMIT $2`,
    [staleMinutes, limit]
  );

  const changed = [];
  for (const row of rows) {
    if (row.current_status === 'NO_SIGNAL') continue;
    await db.none(
      `UPDATE poles SET current_status = 'NO_SIGNAL', updated_at = NOW()
        WHERE pole_id = $1 AND current_status <> 'NO_SIGNAL'`,
      [row.pole_id]
    );
    changed.push({ pole_id: row.pole_id, pole_number: row.pole_number, last_telemetry_at: row.last_telemetry_at });
  }
  return changed;
}

module.exports = { reconcileStaleNodes };
