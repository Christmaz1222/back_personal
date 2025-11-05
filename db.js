const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'personal',
  password: 'loa300581',
  port: 5432,
});

module.exports = pool;