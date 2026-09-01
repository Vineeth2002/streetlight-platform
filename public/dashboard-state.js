(() => {
  'use strict';
  const state={connected:false,lastEventAt:null,assets:new Map(),incidents:new Map(),workOrders:new Map(),sla:new Map(),telemetry:new Map()};
  const listeners=new Set();
  const notify=(type,payload)=>listeners.forEach(fn=>fn(type,payload,state));
  function subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}
  function upsert(map,id,value){if(id==null)return;const key=String(id);map.set(key,{...(map.get(key)||{}),...value});}
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
  window.streetlightDashboardState={state,subscribe,applyEvent,connectWebSocket};
})();
