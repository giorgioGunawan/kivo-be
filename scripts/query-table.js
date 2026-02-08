const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'kivo_ai',
    password: process.env.DB_PASSWORD || 'password',
    port: process.env.DB_PORT || 5432,
});

async function queryTable(tableName, limit = 10) {
    try {
        const res = await pool.query(`SELECT * FROM ${tableName} LIMIT $1`, [limit]);
        console.log(`--- Content of ${tableName} (Limit ${limit}) ---`);
        if (res.rows.length === 0) {
            console.log('(Empty)');
        } else {
            console.table(res.rows);
        }
        console.log('-------------------------');
    } catch (err) {
        console.error(`Error querying table ${tableName}:`, err.message);
    } finally {
        await pool.end();
    }
}

// Get args
const args = process.argv.slice(2);
const table = args[0] || 'users';

queryTable(table);
