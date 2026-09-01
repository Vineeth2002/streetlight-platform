const db = require('../../config/database');

/**
 * Resolve an external source identifier to the platform's canonical asset.
 * Explicit asset IDs win. Otherwise we try existing pole_number and node_id.
 * Vendor-specific IDs should eventually be handled by an explicit mapping
 * table, not by hard-coded rules.
 */
async function resolveAsset(event) {
  if (event.asset_id) {
    const row = await db.oneOrNone(
      `SELECT pole_id::text AS asset_id, pole_number, node_id
         FROM poles WHERE pole_id::text = $1 LIMIT 1`,
      [event.asset_id]
    );
    return row
      ? { asset_id: row.asset_id, pole_number: row.pole_number, node_id: row.node_id, resolution: 'EXPLICIT' }
      : { asset_id: null, resolution: 'UNRESOLVED' };
  }

  const sourceId = event.source_device_id;
  if (!sourceId) return { asset_id: null, resolution: 'UNRESOLVED' };

  const result = await db.oneOrNone(
    `SELECT pole_id::text AS asset_id, pole_number, node_id
       FROM poles
      WHERE pole_number = $1 OR node_id = $1
      LIMIT 1`,
    [sourceId]
  );

  if (!result) return { asset_id: null, resolution: 'UNRESOLVED' };

  return {
    asset_id: result.asset_id,
    pole_number: result.pole_number,
    node_id: result.node_id,
    resolution: result.node_id === sourceId ? 'NODE_ID' : 'POLE_NUMBER',
  };
}

module.exports = { resolveAsset };
