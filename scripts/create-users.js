require('dotenv').config();
const bcrypt = require('bcryptjs');
const db     = require('../config/database');

const users = [
  {
    full_name: 'GVMC Commissioner',
    email:     'commissioner@gvmc.gov.in',
    password:  'Gvmc@1234',
    role:      'GVMC_COMMISSIONER',
    zone_id:   null,
  },
  {
    full_name: 'North Zone EE',
    email:     'ee.north@gvmc.gov.in',
    password:  'Gvmc@1234',
    role:      'GVMC_EE',
    zone_id:   1,
  },
  {
    full_name: 'South Zone EE',
    email:     'ee.south@gvmc.gov.in',
    password:  'Gvmc@1234',
    role:      'GVMC_EE',
    zone_id:   2,
  },
  {
    full_name: 'Vizag Smart Infra',
    email:     'contractor1@vizagsmartinfra.com',
    password:  'Gvmc@1234',
    role:      'CONTRACTOR',
    zone_id:   null,
    contractor_id: 1,
  },
  {
    full_name: 'Field Engineer Raju',
    email:     'field.raju@gvmc.gov.in',
    password:  'Gvmc@1234',
    role:      'FIELD_ENGINEER',
    zone_id:   1,
  },
  {
    full_name: 'Audit Officer',
    email:     'audit@gvmc.gov.in',
    password:  'Gvmc@1234',
    role:      'READ_ONLY',
    zone_id:   null,
  },
];

async function createUsers() {
  console.log('Creating users...\n');
  for (const u of users) {
    try {
      const existing = await db.oneOrNone(
        'SELECT user_id FROM users WHERE email = $1', [u.email]
      );
      if (existing) {
        console.log(`⚠️  Skipped (already exists): ${u.email}`);
        continue;
      }
      const hash = await bcrypt.hash(u.password, 10);
      await db.none(`
        INSERT INTO users (full_name, email, password_hash, role, zone_id, contractor_id)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [u.full_name, u.email, hash, u.role, u.zone_id||null, u.contractor_id||null]);
      console.log(`✅ Created: ${u.email} (${u.role})`);
    } catch (err) {
      console.log(`❌ Failed: ${u.email} — ${err.message}`);
    }
  }
  console.log('\nDone!');
  process.exit(0);
}

createUsers();