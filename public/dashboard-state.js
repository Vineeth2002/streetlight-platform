(() => {
  'use strict';

  const state={
    connected:false,
    lastEventAt:null,
    snapshotLoaded:false,
    snapshotAt:null,
    summary:null,
    zones:[],
    assets:new Map(),
    incidents:new Map(),
    workOrders:new Map(),
    sla:new Map(),
    telemetry:new Map()
  };
  const listeners=new Set();
  const notify=(type,payload)=>listeners.forEach(fn=>{try{fn(type,payload,state);}catch(err){console.error('Dashboard listener error',err);}});
  function subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}
  function upsert(map,id,value){if(id==null)return;const key=String(id);map.set(key,{...(map.get(key)||{}),...value});}

  async function loadSnapshot({baseUrl='' , signal}={}){
    const response=await fetch(`${baseUrl}/api/v1/dashboard/summary`,{
      method:'GET',credentials:'same-origin',headers:{Accept:'application/json'},signal
    });
    if(!response.ok){
      const body=await response.json().catch(()=>({}));
      throw new Error(body.error || `Dashboard snapshot failed (${response.status})`);
    }
    const result=await response.json();
    if(!result.ok) throw new Error(result.error || 'Dashboard snapshot failed');

    state.summary=result.summary||null;
    state.zones=Array.isArray(result.zones)?result.zones:[];
    state.snapshotAt=result.generated_at||new Date().toISOString();
    state.snapshotLoaded=true;

    // Snapshot data is authoritative. Seed the client maps so the UI is useful
    // before the first WebSocket event arrives. Live events can then incrementally
    // update the same maps without replacing the authoritative baseline.
    const s=state.summary||{};
    state.snapshotMetrics={
      totalPoles:Number(s.total_poles||0),
      operationalPoles:Number(s.operational_poles||0),
      faultyPoles:Number(s.faulty_poles||0),
      underRepairPoles:Number(s.under_repair_poles||0),
      noSignalPoles:Number(s.no_signal_poles||0),
      dayBurningPoles:Number(s.day_burning_poles||0),
      glowRatePct:Number(s.glow_rate_pct||0),
      slaBreaches:Number(s.sla_breaches||0),
      penaltyMtdINR:Number(s.penalty_mtd_inr||0),
      openIncidents:Number(s.open_incidents||0),
      openWorkOrders:Number(s.open_work_orders||0)
    };
    notify('snapshot',{summary:state.summary,zones:state.zones,metrics:state.snapshotMetrics,generated_at:state.snapshotAt});
    return result;
  }

  function applyEvent(message){
    if(!message||typeof message!=='object')return;
    const topic=String(message.topic||'').toUpperCase();
    const type=String(message.type||message.event_type||'').toUpperCase();
    const payload=message.data||message.payload||message;
    state.lastEventAt=new Date().toISOString();

    if(topic==='NODE'&&type==='TELEMETRY'){
      const telemetry=payload.telemetry||{}; const diagnosis=payload.diagnosis||null;
      const id=payload.pole_number||telemetry.pole_number||telemetry.node_id;
      upsert(state.telemetry,id,{...telemetry,diagnosis,pole_number:id});
      upsert(state.assets,payload.asset_id||id,{asset_id:payload.asset_id||id,pole_number:id,node_id:telemetry.node_id,last_seen_at:state.lastEventAt,current_state:telemetry.cabinet_on===false||telemetry.active_power===0?'FAULT':'ONLINE',diagnosis});
      notify('telemetry',{pole_number:id,telemetry,diagnosis}); return;
    }
    if(topic==='ALERT'){upsert(state.incidents,payload.incident_id||payload.pole_number||message.ts,payload);notify('incident',payload);return;}
    if(['INCIDENT_CREATED','INCIDENT_UPDATED','INCIDENT'].includes(type)){upsert(state.incidents,payload.incident_id||payload.incident_number,payload);notify('incident',payload);return;}
    if(['WORK_ORDER_UPDATED','WORK_ORDER'].includes(type)){upsert(state.workOrders,payload.work_order_id,payload);notify('work_order',payload);return;}
    if(['SLA_UPDATED','SLA_BREACH','SLA_AT_RISK'].includes(type)){upsert(state.sla,payload.work_order_id,payload);notify('sla',payload);return;}
    notify('event',payload);
  }

  function connectWebSocket({url,protocols}={}){
    if(!url)throw new Error('WebSocket URL is required');
    const ws=new WebSocket(url,protocols);
    ws.addEventListener('open',()=>{state.connected=true;notify('connection',{connected:true});});
    ws.addEventListener('message',event=>{try{applyEvent(JSON.parse(event.data));}catch(err){notify('error',err);}});
    ws.addEventListener('close',()=>{state.connected=false;notify('connection',{connected:false});});
    ws.addEventListener('error',error=>notify('error',error));
    return ws;
  }

  window.streetlightDashboardState={state,subscribe,loadSnapshot,applyEvent,connectWebSocket};
})();
