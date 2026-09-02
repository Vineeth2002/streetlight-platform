/**
 * GVMC Streetlight Platform — Shared Demo Data Store
 * 
 * This file generates demo data ONCE and stores in localStorage.
 * All dashboards read from the same source for consistency.
 * 
 * When real data is available:
 * Set USE_REAL_API = true in each dashboard
 * or toggle via the Live/Demo button (SUPER_ADMIN only)
 */

(function(){
'use strict';

const DEMO_DATA_KEY     = 'sl_demo_data';
const DEMO_DATA_VERSION = 'v1.0';
const DEMO_REFRESH_MS   = 10000; // 10 seconds

// ─── MASTER ZONE DATA ────────────────────────────────────────────────────────
const ZONES = [
  {id:1, name:'North Zone',      lat:17.7626, lng:83.2900, ward_range:[1,14],   area:'Madhurawada, Kommadi, Kapuluppada'},
  {id:2, name:'South Zone',      lat:17.6700, lng:83.2300, ward_range:[15,28],  area:'Daba Gardens, MVP Colony South'},
  {id:3, name:'Central Zone',    lat:17.7200, lng:83.2956, ward_range:[29,42],  area:'Asilmetta, Jagadamba, Ram Nagar'},
  {id:4, name:'East Zone',       lat:17.7400, lng:83.2700, ward_range:[43,56],  area:'Steel Plant, Ukkunagaram, Waltair'},
  {id:5, name:'West Zone',       lat:17.7050, lng:83.2600, ward_range:[57,70],  area:'Pendurthi, Bheemunipatnam West'},
  {id:6, name:'Gajuwaka Zone',   lat:17.6800, lng:83.2050, ward_range:[71,84],  area:'Gajuwaka, Pedagantyada'},
  {id:7, name:'Bheemunipatnam',  lat:17.8900, lng:83.4500, ward_range:[85,98],  area:'Bheemunipatnam, Nakkapalle'},
];

// ─── MASTER CONTRACTOR DATA ───────────────────────────────────────────────────
const CONTRACTORS = [
  {id:1, name:'Vizag Smart Infra Pvt Ltd',    short:'Vizag Smart Infra', zone_id:1, zone:'North Zone',     invoice:4200000, target:98.0},
  {id:2, name:'Andhra LED Solutions Ltd',      short:'Andhra LED',        zone_id:2, zone:'South Zone',     invoice:3800000, target:98.0},
  {id:3, name:'GVMC Street Light Works',       short:'GVMC SLW',          zone_id:3, zone:'Central Zone',   invoice:5100000, target:98.5},
  {id:4, name:'Eastern Coastal Electricals',   short:'Eastern Coastal',   zone_id:4, zone:'East Zone',      invoice:3600000, target:98.0},
  {id:5, name:'Western Hills Power Services',  short:'Western Hills',     zone_id:5, zone:'West Zone',      invoice:3900000, target:98.0},
  {id:6, name:'Gajuwaka Lighting Consortium',  short:'Gajuwaka Lighting', zone_id:6, zone:'Gajuwaka Zone',  invoice:4500000, target:97.5},
  {id:7, name:'Coastal Smart Energy Ltd',      short:'Coastal Energy',    zone_id:7, zone:'Bheemunipatnam', invoice:2800000, target:98.0},
];

const FAULT_TYPES = ['DRIVER_FAULT','LINE_FAULT','DAY_BURNING_FAULT','PREDICTIVE_DEGRADATION','CABLE_THEFT','CABINET_FAULT'];
const FAULT_LABELS = {
  'DRIVER_FAULT':           'Driver Board Failure',
  'LINE_FAULT':             'Overhead Cable Short',
  'DAY_BURNING_FAULT':      'Day Burning',
  'PREDICTIVE_DEGRADATION': 'PCB Salt Decay',
  'CABLE_THEFT':            'Cable Theft',
  'CABINET_FAULT':          'CCMS Box Failure',
};
const SEVERITIES = {
  'LINE_FAULT':'CRITICAL','DRIVER_FAULT':'MEDIUM',
  'DAY_BURNING_FAULT':'HIGH','PREDICTIVE_DEGRADATION':'LOW',
  'CABLE_THEFT':'HIGH','CABINET_FAULT':'HIGH',
};
const TEAMS = ['Team Alpha','Team Beta','Team Delta','Team Sigma','Team Omega'];
const WIRING = ['OVERHEAD','OVERHEAD','OVERHEAD','UNDERGROUND'];
const WATTAGES = [40,70,70,110,120,150];

// ─── GENERATE CONSISTENT DEMO DATA ───────────────────────────────────────────
function generateDemoData(){
  let seed = 20260801;
  function rand(min, max){
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    const r = Math.abs(seed) / 0x7fffffff;
    return min + r * (max - min);
  }
  function randInt(min, max){ return Math.floor(rand(min, max)); }
  function randItem(arr){ return arr[randInt(0, arr.length)]; }

  const zones = ZONES.map(z => ({
    ...z, glow: parseFloat((95 + rand(0, 4)).toFixed(1)), faults: randInt(100, 900), penalty: randInt(10000, 90000), contractor: CONTRACTORS.find(c => c.zone_id === z.id),
  }));

  const workOrders = [];
  for(let i = 0; i < 50; i++){
    const zone=randItem(ZONES), wardNum=randInt(zone.ward_range[0], zone.ward_range[1]+1), fault=randItem(FAULT_TYPES), contractor=CONTRACTORS.find(c=>c.zone_id===zone.id), minsAgo=randInt(10,4000), hoursOpen=minsAgo/60, slaBreached=hoursOpen>48, resolved=Math.abs(rand(0,1))>0.4&&!slaBreached, daysOverdue=slaBreached?Math.ceil(hoursOpen/24-2):0, wattage=randItem(WATTAGES);
    const penaltyA=slaBreached?2*((wattage/1000)*11*daysOverdue*6):0, penaltyB=slaBreached?25*daysOverdue*randInt(5,30):0, penalty=parseFloat(Math.max(penaltyA,penaltyB).toFixed(2));
    const reported=new Date(Date.now()-minsAgo*60000), deadline=new Date(reported.getTime()+48*3600000);
    workOrders.push({work_order_id:1000+i,pole_number:`VSP-${zone.name.charAt(0)}-${String(randInt(1,99999)).padStart(5,'0')}`,zone_id:zone.id,zone_name:zone.name,ward_number:wardNum,contractor_id:contractor?.id||null,contractor_name:contractor?.name||'Unknown',contractor_short:contractor?.short||'Unknown',fault_category:fault,fault_label:FAULT_LABELS[fault],severity:SEVERITIES[fault],team:randItem(TEAMS),wiring_type:randItem(WIRING),luminaire_wattage:wattage,reported_timestamp:reported.toISOString(),sla_deadline:deadline.toISOString(),ticket_status:resolved?'RESOLVED':slaBreached?'SLA_VIOLATED':randItem(['PENDING','ASSIGNED','IN_PROGRESS']),hours_open:parseFloat(hoursOpen.toFixed(1)),sla_breached:slaBreached,resolved,days_overdue:daysOverdue,penalty_deducted:penalty,lat:zone.lat+(rand(0,1)-0.5)*0.08,lng:zone.lng+(rand(0,1)-0.5)*0.08});
  }
  return {version:DEMO_DATA_VERSION,generated_at:Date.now(),zones,workOrders,contractors:CONTRACTORS,fault_labels:FAULT_LABELS,fault_types:FAULT_TYPES,teams:TEAMS};
}

function initDemoData(){
  try{const existing=localStorage.getItem(DEMO_DATA_KEY);if(existing){const parsed=JSON.parse(existing);if(parsed.version===DEMO_DATA_VERSION)return parsed;}}catch(e){}
  const data=generateDemoData();try{localStorage.setItem(DEMO_DATA_KEY,JSON.stringify(data));}catch(e){}return data;
}
function getDemoData(){try{const stored=localStorage.getItem(DEMO_DATA_KEY);if(stored)return JSON.parse(stored);}catch(e){}return initDemoData();}
function clearDemoData(){localStorage.removeItem(DEMO_DATA_KEY);}
function updateDemoData(){
  const data=getDemoData(); if(!data)return;
  data.zones=data.zones.map(z=>({...z,glow:parseFloat(Math.max(93,Math.min(99.9,parseFloat(z.glow)+(Math.random()-0.5)*0.3)).toFixed(1)),faults:Math.max(50,z.faults+Math.floor((Math.random()-0.5)*10)),penalty:Math.max(5000,z.penalty+Math.floor((Math.random()-0.5)*1000))}));
  const zone=data.zones[Math.floor(Math.random()*data.zones.length)], fault=data.fault_types[Math.floor(Math.random()*data.fault_types.length)], contractor=data.contractors.find(c=>c.zone_id===zone.id);
  const newWO={work_order_id:Date.now(),pole_number:`VSP-${zone.name.charAt(0)}-${String(Math.floor(Math.random()*99999)).padStart(5,'0')}`,zone_id:zone.id,zone_name:zone.name,ward_number:Math.floor(Math.random()*(zone.ward_range[1]-zone.ward_range[0]+1))+zone.ward_range[0],contractor_id:contractor?.id||null,contractor_name:contractor?.name||'Unknown',contractor_short:contractor?.short||'Unknown',fault_category:fault,fault_label:data.fault_labels[fault],severity:SEVERITIES[fault],team:TEAMS[Math.floor(Math.random()*TEAMS.length)],wiring_type:WIRING[Math.floor(Math.random()*WIRING.length)],luminaire_wattage:WATTAGES[Math.floor(Math.random()*WATTAGES.length)],reported_timestamp:new Date().toISOString(),sla_deadline:new Date(Date.now()+48*3600000).toISOString(),ticket_status:'PENDING',hours_open:0,sla_breached:false,resolved:false,days_overdue:0,penalty_deducted:0,lat:zone.lat+(Math.random()-0.5)*0.08,lng:zone.lng+(Math.random()-0.5)*0.08,is_new:true};
  data.workOrders.unshift(newWO);if(data.workOrders.length>60)data.workOrders.pop();data.workOrders.forEach((w,i)=>{if(i>0)delete w.is_new;});data.generated_at=Date.now();try{localStorage.setItem(DEMO_DATA_KEY,JSON.stringify(data));}catch(e){}return data;
}
function getDemoZones(){return getDemoData()?.zones||[];}
function getDemoWorkOrders(zoneId,contractorId){const wos=getDemoData()?.workOrders||[];if(zoneId)return wos.filter(w=>w.zone_id===zoneId);if(contractorId)return wos.filter(w=>w.contractor_id===contractorId);return wos;}
function getDemoSLABreaches(zoneId){return getDemoWorkOrders(zoneId).filter(w=>w.sla_breached&&w.ticket_status!=='RESOLVED');}
function getDemoContractors(){return getDemoData()?.contractors||[];}
window.SL_DEMO={init:initDemoData,get:getDemoData,update:updateDemoData,clear:clearDemoData,getZones:getDemoZones,getWorkOrders:getDemoWorkOrders,getSLABreaches:getDemoSLABreaches,getContractors:getDemoContractors,ZONES,CONTRACTORS,FAULT_LABELS,FAULT_TYPES,TEAMS};
initDemoData();

})();

// Live-state scripts are loaded after the legacy demo store so the existing dashboard remains intact.
(function(){
  const load=(src,done)=>{const s=document.createElement('script');s.src=src;s.async=false;s.onload=done;s.onerror=()=>console.warn('[live] failed to load '+src);document.head.appendChild(s);};
  load('/dashboard-state.js',()=>load('/live-bridge.js'));
})();
