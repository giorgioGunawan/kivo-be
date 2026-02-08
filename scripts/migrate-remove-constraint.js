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
        console.log('Migrating: Removing reason check constraint from credit_ledger...');

        // Remove the existing constraint
        await client.query(`
            ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_reason_check;
        `);

        console.log('Migration successful!');
    } catch (err) {
        console.error('Migration failed:', err.message);
    } finally {
        await client.end();
    }
}

migrate();
