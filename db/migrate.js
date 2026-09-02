require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const migrations = [
  '001_schema.sql','002_triggers.sql','003_seed.sql','004_schema.sql',
];
