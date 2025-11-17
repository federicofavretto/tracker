// db.js
const { Pool } = require('pg');

console.log('DATABASE_URL presente?', !!process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

module.exports = pool;
