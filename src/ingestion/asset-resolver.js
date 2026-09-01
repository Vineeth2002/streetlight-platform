const db = require('../db');

/**
 * Resolve an external source identifier to the platform's canonical asset.
 *
 * The first implementation deliberately supports existing pole/node IDs.
 * Future CCMS integrations should add an explicit external-identifier mapping
 * table rather than embedding vendor-specific rules throughout the codebase.
 */
async function resolveAsset(event) {
  if (event.asset_id) {
    return { asset_id: event.asset_id, resolution: 'EXPLICIT' };
  }

  const sourceId = event.source_device_id;
  if (!sourceId) return { asset_id: null, resolution: 'UNRESOLVED' };

  const result = await db.query(
    `SELECT pole_id::text AS asset_id
       FROM poles
      WHERE pole_id::text = $1
      LIMIT 1`,
    [sourceId]
  );

  if (result.rows.length) {
    return { asset_id: result.rows[0].asset_id, resolution: 'POLE_ID' };
  }

  return { asset_id: null, resolution: 'UNRESOLVED' };
}

module.exports = { resolveAsset };
