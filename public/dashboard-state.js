(() => {
  'use strict';
  const state={connected:false,lastEventAt:null,snapshotLoaded:false,snapshotAt:null,summary:null,zones:[],assets:new Map(),incidents:new Map(),workOrders:new Map(),sla:new Map(),telemetry:new Map()};
  const listeners=new Set();
  let map=null,markers=new Map(),viewportTimer=null,viewportRequest=0;
  const notify=(type,payload)=>listeners.forEach(fn=>{try{fn(type,payload,state);}catch(err){console.error('Dashboard listener error',err);}});
  function subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}
  function upsert(map,id,value){if(id==null)return;const key=String(id);map.set(key,{...(map.get(key)||{}),...value});}
  function initMap(){
    if(map||!window.L||!document.getElementById('map'))return;
    map=L.map('map',{preferCanvas:true}).setView([17.6868,83.2185],12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
    map.on('moveend',()=>{clearTimeout(viewportTimer);viewportTimer=setTimeout(loadVisibleAssets,150);});
  }
  function markerColor(status){return status==='FAULTY'||status==='FAULT'?'#ff5252':status==='UNDER_REPAIR'?'#ffab40':status==='NO_SIGNAL'?'#90a4ae':'#00e676';}
  function markerPopup(a,status){return `<strong>${a.pole_number||a.pole_id||'—'}</strong><br>Status: ${status}<br>Zone: ${a.zone_name||'—'}<br>Ward: ${a.ward_number||'—'}<br>Road: ${a.road_name||'—'}<br>Voltage: ${a.nominal_voltage||'—'} V`;}
  function renderAssets(assets,{fit=false}={}){
    initMap(); if(!map)return;
    const visible=new Set(),bounds=[];
    (assets||[]).forEach(a=>{
      const lat=Number(a.latitude),lng=Number(a.longitude); if(!Number.isFinite(lat)||!Number.isFinite(lng))return;
      const id=String(a.pole_id||a.pole_number); visible.add(id); bounds.push([lat,lng]);
      const status=a.current_status||a.current_state||'UNKNOWN',color=markerColor(status),popup=markerPopup(a,status),existing=markers.get(id);
      if(existing){existing.setLatLng([lat,lng]);existing.setStyle({color,fillColor:color});existing.setPopupContent(popup);}
      else {const marker=L.circleMarker([lat,lng],{radius:4,color,fillColor:color,fillOpacity:.85,weight:1});marker.bindPopup(popup);marker.addTo(map);markers.set(id,marker);}
    });
    markers.forEach((marker,id)=>{if(!visible.has(id)){map.removeLayer(marker);markers.delete(id);}});
    if(fit&&bounds.length)map.fitBounds(bounds,{padding:[20,20],maxZoom:15});
  }
  async function loadVisibleAssets(){
    initMap(); if(!map)return;
    const b=map.getBounds(),seq=++viewportRequest;
    const params=new URLSearchParams({min_lat:b.getSouth().toFixed(6),min_lng:b.getWest().toFixed(6),max_lat:b.getNorth().toFixed(6),max_lng:b.getEast().toFixed(6),limit:'5000'});
    try{
      const response=await fetch(`/api/v1/dashboard/assets?${params.toString()}`,{credentials:'same-origin',headers:{Accept:'application/json'}});
      if(!response.ok)throw new Error(`Viewport asset query failed (${response.status})`);
      const result=await response.json(); if(!result.ok)throw new Error(result.error||'Viewport asset query failed');
      if(seq!==viewportRequest)return;
      const assets=Array.isArray(result.assets)?result.assets:[];
      assets.forEach(a=>upsert(state.assets,a.pole_id||a.pole_number,a));
      renderAssets(assets);
      const label=document.getElementById('map-last-update'); if(label)label.textContent=`${assets.length.toLocaleString('en-IN')} assets in viewport · ${new Date().toLocaleTimeString()}`;
      notify('assets_viewport',{assets});
    }catch(err){console.error('Viewport asset load error',err);notify('error',err);}
  }
  async function loadSnapshot({baseUrl='',signal}={}){
    const response=await fetch(`${baseUrl}/api/v1/dashboard/summary`,{credentials:'same-origin',headers:{Accept:'application/json'},signal});
    if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.error||`Dashboard snapshot failed (${response.status})`);}
    const result=await response.json(); if(!result.ok)throw new Error(result.error||'Dashboard snapshot failed');
    state.summary=result.city||{};state.zones=Array.isArray(result.zones)?result.zones:[];state.snapshotAt=result.generated_at||new Date().toISOString();state.snapshotLoaded=true;
    state.snapshotMetrics={totalPoles:Number(state.summary.total_poles||0),operationalPoles:Number(state.summary.operational_poles||0),faultyPoles:Number(state.summary.faulty_poles||0),underRepairPoles:Number(state.summary.under_repair_poles||0),noSignalPoles:Number(state.summary.no_signal_poles||0),dayBurningPoles:Number(state.summary.day_burn_poles||0),glowRatePct:Number(state.summary.glow_rate_pct||0),slaBreaches:Number(state.summary.sla_breaches||0),penaltyMtdINR:Number(state.summary.penalty_mtd_inr||0),openIncidents:Number(state.summary.open_incidents||0),openWorkOrders:Number(state.summary.open_work_orders||0)};
    (result.assets||[]).forEach(a=>upsert(state.assets,a.pole_id||a.pole_number,a));
    (result.incidents||[]).forEach(i=>upsert(state.incidents,i.incident_id||i.incident_number,i));
    (result.work_orders||[]).forEach(w=>upsert(state.workOrders,w.work_order_id,w));
    (result.sla||[]).forEach(s=>upsert(state.sla,s.work_order_id,s));
    notify('snapshot',{summary:state.summary,zones:state.zones,metrics:state.snapshotMetrics,assets:[...state.assets.values()],incidents:[...state.incidents.values()],work_orders:[...state.workOrders.values()],sla:[...state.sla.values()],generated_at:state.snapshotAt});
    setTimeout(()=>loadVisibleAssets(),0);
    return result;
  }
  function applyEvent(message){
    if(!message||typeof message!=='object')return;
    const topic=String(message.topic||'').toUpperCase(),type=String(message.type||message.event_type||'').toUpperCase(),payload=message.data||message.payload||message;
    state.lastEventAt=new Date().toISOString();
    if(topic==='NODE'&&type==='TELEMETRY'){
      const telemetry=payload.telemetry||{},diagnosis=payload.diagnosis||null,id=payload.pole_number||telemetry.pole_number||telemetry.node_id;
      upsert(state.telemetry,id,{...telemetry,diagnosis,pole_number:id});
      const assetId=payload.asset_id||id,existing=state.assets.get(String(assetId))||{};
      upsert(state.assets,assetId,{asset_id:assetId,pole_number:id,node_id:telemetry.node_id,last_seen_at:state.lastEventAt,current_state:telemetry.cabinet_on===false||telemetry.active_power===0?'FAULT':'ONLINE',diagnosis,latitude:payload.latitude??existing.latitude,longitude:payload.longitude??existing.longitude,current_status:payload.current_status??existing.current_status});
      const asset=state.assets.get(String(assetId)); if(asset)renderAssets([asset]);notify('telemetry',{pole_number:id,telemetry,diagnosis});return;
    }
    if(topic==='ALERT'){upsert(state.incidents,payload.incident_id||payload.pole_number||message.ts,payload);notify('incident',payload);return;}
    if(['INCIDENT_CREATED','INCIDENT_UPDATED','INCIDENT'].includes(type)){upsert(state.incidents,payload.incident_id||payload.incident_number,payload);notify('incident',payload);return;}
    if(['WORK_ORDER_UPDATED','WORK_ORDER'].includes(type)){upsert(state.workOrders,payload.work_order_id,payload);notify('work_order',payload);return;}
    if(['SLA_UPDATED','SLA_BREACH','SLA_AT_RISK'].includes(type)){upsert(state.sla,payload.work_order_id,payload);notify('sla',payload);return;}
    notify('event',payload);
  }
  function connectWebSocket({url,protocols}={}){
    if(!url)throw new Error('WebSocket URL is required');const ws=new WebSocket(url,protocols);
    ws.addEventListener('open',()=>{state.connected=true;notify('connection',{connected:true});});
    ws.addEventListener('message',event=>{try{applyEvent(JSON.parse(event.data));}catch(err){notify('error',err);}});
    ws.addEventListener('close',()=>{state.connected=false;notify('connection',{connected:false});});
    ws.addEventListener('error',error=>notify('error',error));return ws;
  }
  window.streetlightDashboardState={state,subscribe,loadSnapshot,applyEvent,connectWebSocket,initMap,loadVisibleAssets};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initMap);else initMap();
})();
