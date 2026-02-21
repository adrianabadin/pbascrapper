require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function applySchema() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  
  const { rows } = await client.query('SELECT version(), current_database()');
  console.log('DB:', rows[0].current_database, '|', rows[0].version.split(' ').slice(0,2).join(' '));
  
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('COMMIT');
    console.log('Schema aplicado correctamente');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
}

applySchema().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
