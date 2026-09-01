const db = require('../../config/database');

/**
 * Resolve an external source identifier to the platform's canonical asset.
 *
 * The first implementation supports existing pole/node identifiers. Future
 * CCMS integrations should use an explicit external-identifier mapping table
 * rather than spreading vendor-specific rules through the application.
 */
async function resolveAsset(event) {
  if (event.asset_id) {
    return { asset_id: event.asset_id, resolution: 'EXPLICIT' };
  }

  const sourceId = event.source_device_id;
  if (!sourceId) return { asset_id: null, resolution: 'UNRESOLVED' };

  const result = await db.any(
    `SELECT pole_id::text AS asset_id
       FROM poles
      WHERE pole_id::text = $1
         OR node_id::text = $1
      LIMIT 1`,
    [sourceId]
  );

  if (result.length) {
    return {
      asset_id: result[0].asset_id,
      resolution: 'POLE_OR_NODE_ID',
    };
  }

  return { asset_id: null, resolution: 'UNRESOLVED' };
}

module.exports = { resolveAsset };
