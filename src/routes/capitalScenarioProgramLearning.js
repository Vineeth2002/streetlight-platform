'use strict';
const express=require('express');
const db=require('../../config/database');
const logger=require('../utils/logger');
const {requireAuth,requireRole}=require('../middleware/auth');
const router=express.Router();
const READ=['SUPER_ADMIN','GVMC_COMMISSIONER','GVMC_EE','READ_ONLY'];
router.use(requireAuth);
function assertScopedIdentity(user,res){if(user.role==='GVMC_EE'&&!user.zone_id){res.status(403).json({ok:false,error:'Access denied: user has no assigned zone'});return false;}return true;}
function scope(user,params,where,alias='v'){if(user.role==='GVMC_EE'){params.push(user.zone_id);where.push(`${alias}.zone_id=$${params.length}`);}}
router.get('/patterns',requireRole(...READ),async(req,res)=>{if(!assertScopedIdentity(req.user,res))return;try{const params=[],where=[];scope(req.user,params,where);if(req.query.scenario_key){params.push(req.query.scenario_key);where.push(`v.scenario_key=$${params.length}`);}const rows=await db.manyOrNone(`SELECT * FROM v_municipal_capital_scenario_program_learning v ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY CASE learning_signal WHEN 'NEGATIVE_PATTERN' THEN 1 WHEN 'INSUFFICIENT_EVIDENCE' THEN 2 WHEN 'MIXED_PATTERN' THEN 3 ELSE 4 END,attributed_outcomes DESC,scenario_key LIMIT 1000`,params);res.json({ok:true,advisory:true,scenario_program_learning:true,data:rows});}catch(e){logger.error('Scenario-program learning error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}});
router.get('/summary',requireRole(...READ),async(req,res)=>{if(!assertScopedIdentity(req.user,res))return;try{const params=[],where=[];scope(req.user,params,where);if(req.query.scenario_key){params.push(req.query.scenario_key);where.push(`v.scenario_key=$${params.length}`);}const rows=await db.manyOrNone(`SELECT * FROM v_municipal_capital_scenario_program_learning_summary v ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY attributed_outcomes DESC,scenario_key`,params);res.json({ok:true,advisory:true,data:rows});}catch(e){logger.error('Scenario-program learning summary error',{error:e.message});res.status(500).json({ok:false,error:'Internal server error'});}});
module.exports=router;
