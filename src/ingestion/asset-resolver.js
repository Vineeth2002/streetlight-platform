const db = require('../../config/database');

/**
 * Resolve an external source identifier to the platform's canonical asset.
 * Explicit asset IDs win. Otherwise we try the existing pole_number and
 * CCMS node_id fields. A future vendor integration should use a dedicated
 * external_asset_mappings table instead of embedding vendor-specific rules.
 */
async function resolveAsset(event) {
  if (event.asset_id) {
    return { asset_id: event.asset_id, resolution: 'EXPLICIT' };
  }

  const sourceId = event.source_device_id;
  if (!sourceId) return { asset_id: null, resolution: 'UNRESOLVED' };

  const result = await db.oneOrNone(
    `SELECT pole_id::text AS asset_id, pole_number, node_id
       FROM poles
      WHERE pole_id::text = $1
         OR pole_number = $1
         OR node_id = $1
      LIMIT 1`,
    [sourceId]
  );

  if (!result) return { asset_id: null, resolution: 'UNRESOLVED' };

  const resolution = result.node_id === sourceId
    ? 'NODE_ID'
    : result.pole_number === sourceId
      ? 'POLE_NUMBER'
      : 'POLE_ID';

  return {
    asset_id: result.asset_id,
    pole_number: result.pole_number,
    node_id: result.node_id,
    resolution,
  };
}

module.exports = { resolveAsset };
