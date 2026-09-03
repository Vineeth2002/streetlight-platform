'use strict';
const express=require('express');
const db=require('../../config/database');
const logger=require('../utils/logger');
const {requireAuth,requireRole}=require('../middleware/auth');
const router=express.Router();
const READ=['SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','READ_ONLY'];
router.use(requireAuth,requireRole(...READ));
function assertScopedIdentity(user,res){
 if(user.role==='GVMC_EE'&&!user.zone_id){res.status(403).json({ok:false,error:'Access denied: user has no assigned zone'});return false;}
 return true;
}
function scope(user,params,where){if(user.role==='GVMC_EE'){params.push(user.zone_id);where.push(`v.zone_id=$${params.length}`);}}
router.get('/cabinets',async(req,res)=>{if(!assertScopedIdentity(req.user,res))return;try{const params=[],where=[];scope(req.user,params,where);if(req.query.min_risk!==undefined){const n=Number(req.query.min_risk);if(!Number.isFinite(n)||n<0||n>100)return res.status(400).json({ok:false,error:'Invalid min_risk'});params.push(n);where.push(`v.dependency_risk_score>=$${params.length}`);}const rows=await db.manyOrNone(`SELECT * FROM v_cabinet_dependency_intelligence v ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY dependency_risk_score DESC,cabinet_id LIMIT 1000`,params);res.json({ok:true,advisory:true,dependency_intelligence:true,data:rows});}catch(e){logger.error('Dependency intelligence cabinets error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}});
router.get('/cabinets/:id',async(req,res)=>{if(!assertScopedIdentity(req.user,res))return;const id=Number.parseInt(req.params.id,10);if(!Number.isInteger(id))return res.status(400).json({ok:false,error:'Invalid cabinet id'});try{const params=[id],where=['v.cabinet_id=$1'];scope(req.user,params,where);const cabinet=await db.oneOrNone(`SELECT * FROM v_cabinet_dependency_intelligence v WHERE ${where.join(' AND ')}`,params);if(!cabinet)return res.status(404).json({ok:false,error:'Cabinet not found'});const assets=await db.manyOrNone(`SELECT p.pole_id,p.pole_number,p.current_status,p.road_name,p.luminaire_wattage FROM poles p WHERE p.cabinet_id=$1 AND p.current_status<>'DECOMMISSIONED' ORDER BY p.pole_number`,[id]);res.json({ok:true,advisory:true,dependency_intelligence:true,data:{cabinet,assets}});}catch(e){logger.error('Dependency intelligence detail error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}});
router.get('/summary',async(req,res)=>{if(!assertScopedIdentity(req.user,res))return;try{const params=[],where=[];scope(req.user,params,where);const rows=await db.manyOrNone(`SELECT zone_id,zone_name,COUNT(*)::int AS cabinets,COUNT(*) FILTER(WHERE dependency_risk_score>=70)::int AS high_risk_cabinets,COUNT(*) FILTER(WHERE dependency_risk_score>=85)::int AS critical_cabinets,SUM(faulty_assets)::int AS faulty_assets,SUM(no_signal_assets)::int AS no_signal_assets FROM v_cabinet_dependency_intelligence v ${where.length?'WHERE '+where.join(' AND '):''} GROUP BY zone_id,zone_name ORDER BY high_risk_cabinets DESC,critical_cabinets DESC`,params);res.json({ok:true,advisory:true,dependency_intelligence:true,data:rows});}catch(e){logger.error('Dependency intelligence summary error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}});
module.exports=router;
