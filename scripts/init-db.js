const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function initDb() {
    // If DATABASE_URL is present (e.g. Railway/Render), use it directly
    if (process.env.DATABASE_URL) {
        console.log('Using DATABASE_URL for initialization...');
        const client = new Client({ connectionString: process.env.DATABASE_URL });
        try {
            await client.connect();
            const schemaPath = path.join(__dirname, '../schema.sql');
            const schemaSql = fs.readFileSync(schemaPath, 'utf8');
            await client.query(schemaSql);
            console.log('Schema applied successfully to production DB!');
            return;
        } catch (err) {
            console.error('Failed to initialize production database:', err.message);
            process.exit(1);
        } finally {
            await client.end();
        }
    }

    const config = {
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'password',
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 5432,
    };

    // 1. Connect to default 'postgres' db to create our db if needed
    const client = new Client({ ...config, database: 'postgres' });

    try {
        await client.connect();

        const dbName = process.env.DB_NAME || 'kivo_ai';
        const checkDb = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);

        if (checkDb.rows.length === 0) {
            console.log(`Creating database ${dbName}...`);
            await client.query(`CREATE DATABASE ${dbName}`);
        } else {
            console.log(`Database ${dbName} already exists.`);
        }
    } catch (err) {
        if (err.code === 'ECONNREFUSED') {
            console.error('Error: Could not connect to PostgreSQL. Is the server running on port 5432?');
            process.exit(1);
        }
        // If auth fails to 'postgres' db, it might be fine if the target db exists and we have creds for that.
        // But usually we need admin access to create DBs.
        // Let's warn and try to proceed if we can't connect to 'postgres' but maybe 'kivo_ai' exists?
        // Actually, usually it's better to fail fast here.
        console.error('Error connecting to postgres database:', err.message);
        // Proceeding to try connecting to target DB directly in case 'postgres' access was denied but target exists
    } finally {
        await client.end();
    }

    // 2. Connect to actual DB and run schema
    const dbName = process.env.DB_NAME || 'kivo_ai';
    const dbClient = new Client({ ...config, database: dbName });

    try {
        await dbClient.connect();
        console.log(`Connected to ${dbName}. Running schema migration...`);

        const schemaPath = path.join(__dirname, '../schema.sql');
        const schemaSql = fs.readFileSync(schemaPath, 'utf8');

        await dbClient.query(schemaSql);
        console.log('Schema applied successfully!');
    } catch (err) {
        console.error('Failed the initialize database:', err.message);
        process.exit(1);
    } finally {
        await dbClient.end();
    }
}

initDb();
