const { Client } = require('pg');
require('dotenv').config();

async function migrate() {
    const client = new Client({
        user: process.env.DB_USER || 'kivo_user',
        password: process.env.DB_PASSWORD || 'password',
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 5432,
        database: process.env.DB_NAME || 'kivo_ai',
    });

    try {
        await client.connect();
        console.log('Migrating: Adding result_url to jobs table...');
        await client.query(`
            ALTER TABLE jobs ADD COLUMN IF NOT EXISTS result_url TEXT;
        `);
        console.log('Migration successful!');
    } catch (err) {
        console.error('Migration failed:', err.message);
    } finally {
        await client.end();
    }
}

migrate();
