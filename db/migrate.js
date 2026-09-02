require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const migrations = [
  '001_schema.sql','002_triggers.sql','003_seed.sql','004_security.sql','005_ingestion_incidents.sql','006_incident_work_order_link.sql','007_execution_evidence.sql','008_sla_runtime.sql','009_cabinet_correlation.sql','010_fault_episodes.sql','011_staff_accountability.sql','012_contractor_penalty_ledger.sql','013_asset_intelligence.sql','014_durability_intelligence.sql','015_procurement_intelligence.sql','016_knowledge_policy_intelligence.sql','017_predictive_decision_intelligence.sql','018_asset_lifecycle_intelligence.sql','019_contractor_accountability_intelligence.sql','020_financial_contract_intelligence.sql','021_budget_expenditure_intelligence.sql','022_asset_replacement_capital_planning.sql','023_spatial_infrastructure_intelligence.sql','024_asset_condition_health_index.sql','025_incident_root_cause_intelligence.sql','026_municipal_intervention_intelligence.sql','027_intervention_outcome_learning.sql','028_municipal_intelligence_feedback.sql','029_municipal_risk_early_warning.sql','030_dependency_intelligence.sql','031_network_topology_intelligence.sql','032_failure_propagation_intelligence.sql','033_failure_correlation_intelligence.sql','034_municipal_asset_risk_graph.sql','035_municipal_network_risk_intelligence.sql','036_municipal_risk_command_layer.sql','037_municipal_risk_temporal_intelligence.sql','038_municipal_risk_forecasting.sql','039_municipal_risk_scenario_intelligence.sql','040_municipal_resource_allocation_intelligence.sql','041_municipal_program_portfolio_intelligence.sql',
];

async function runMigrations() {
  const client = new Client({ host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT), database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  try {
    await client.connect();
    console.log(`Connected to: ${process.env.DB_NAME}`);
    for (const file of migrations) { const sql = fs.readFileSync(path.join(__dirname, file), 'utf8'); console.log(`Running: ${file}`); await client.query(sql); console.log(`Done: ${file}`); }
    console.log('\nAll migrations complete.');
  } catch (err) { console.error('Migration failed:', err.message); process.exit(1); }
  finally { await client.end(); }
}
runMigrations();
