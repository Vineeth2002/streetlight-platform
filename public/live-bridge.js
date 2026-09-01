(() => {
  'use strict';
  const start = () => {
    const S = window.streetlightDashboardState;
    if (!S) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws`;
    S.subscribe((type, payload, state) => {
      window.dispatchEvent(new CustomEvent('streetlight:live', { detail:{ type, payload, state } }));
    });
    try { S.connectWebSocket({ url }); } catch (e) { console.warn('[live-bridge] WebSocket unavailable', e); }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once:true }); else start();
})();
