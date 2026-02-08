const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'kivo_ai',
    password: process.env.DB_PASSWORD || 'password',
    port: process.env.DB_PORT || 5432,
});

async function listTables() {
    try {
        const res = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
        console.log('--- Tables in kivo_ai ---');
        res.rows.forEach(row => console.log(row.table_name));
        console.log('-------------------------');
    } catch (err) {
        console.error('Error listing tables:', err.message);
    } finally {
        await pool.end();
    }
}

listTables();
