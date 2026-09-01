(() => {
  'use strict';

  // Lightweight grid clustering for the command-center map. It deliberately
  // avoids loading another client dependency: the backend remains the source
  // of truth and the browser only groups the assets already returned for the
  // current viewport.
  function clusterAssets(assets, zoom) {
    const cellPx = zoom <= 11 ? 72 : zoom <= 13 ? 56 : 42;
    const buckets = new Map();
    const project = (lat, lng) => {
      const scale = Math.pow(2, zoom);
      const x = ((lng + 180) / 360) * 256 * scale;
      const sin = Math.sin((lat * Math.PI) / 180);
      const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * 256 * scale;
      return {x, y};
    };
    for (const asset of assets || []) {
      const lat = Number(asset.latitude), lng = Number(asset.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const p = project(lat, lng);
      const key = `${Math.floor(p.x / cellPx)}:${Math.floor(p.y / cellPx)}`;
      const bucket = buckets.get(key) || {assets:[],latSum:0,lngSum:0,faulty:0,repair:0,noSignal:0};
      bucket.assets.push(asset); bucket.latSum += lat; bucket.lngSum += lng;
      const status = asset.current_status || asset.current_state;
      if (status === 'FAULTY' || status === 'FAULT') bucket.faulty++;
      if (status === 'UNDER_REPAIR') bucket.repair++;
      if (status === 'NO_SIGNAL') bucket.noSignal++;
      buckets.set(key,bucket);
    }
    return [...buckets.values()].map(bucket => ({
      count: bucket.assets.length,
      latitude: bucket.latSum / bucket.assets.length,
      longitude: bucket.lngSum / bucket.assets.length,
      faulty: bucket.faulty,
      underRepair: bucket.repair,
      noSignal: bucket.noSignal,
      assets: bucket.assets,
      clustered: bucket.assets.length > 1
    }));
  }

  window.streetlightLeafletCluster = {clusterAssets};
})();
