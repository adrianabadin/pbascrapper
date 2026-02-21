require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function applySchema() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log('Conectado a PostgreSQL...');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await client.query(sql);
  console.log('Schema aplicado correctamente');
  await client.end();
}

applySchema().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
