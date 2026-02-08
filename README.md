# Kivo AI Backend

Node.js Backend for Kivo AI matching the architectural specification.

## Prerequisites

- Node.js (v18+)
- PostgreSQL
- Redis (for BullMQ)

## Setup

1.  **Install Dependencies:**
    ```bash
    npm install
    ```

2.  **Environment Configuration:**
    Create a `.env` file based on `.env.example` (or configure inline).
    ```bash
    DB_USER=postgres
    DB_PASSWORD=password
    DB_HOST=localhost
    DB_NAME=kivo_ai
    DB_PORT=5432
    REDIS_URL=redis://localhost:6379
    JWT_SECRET=your_jwt_secret
    ADMIN_PASSWORD=admin123
    AI_PROVIDER=mock
    ```

3.  **Database Migration:**
    Run the schema SQL to initialize tables.
    ```bash
    psql -U postgres -d kivo_ai -f schema.sql
    ```

4.  **Run Development Server:**
    ```bash
    npm run dev
    ```

## Architecture

- **API Layer**: Express.js routes for Auth, Credits, Jobs, Admin.
- **Job Queue**: BullMQ (Redis-backed) handles async job processing.
- **Database**: PostgreSQL (Single source of truth for Credits/Subscriptions).
- **Services**:
    - `jobs/manager.js`: Handles job creation & credit deduction.
    - `jobs/processor.js`: Worker logic for processing jobs.
    - `credits/ledger.js`: Authoritative ledger logic.
    - `auth/apple.js`: Apple Sign-In & IAP verification.

## Endpoints

- `POST /auth/apple`: Sign in with Apple Identity Token.
- `POST /auth/subscription/verify`: Verify IAP subscription.
- `POST /jobs`: Create a new generation job (Idempotent).
- `GET /jobs/:id`: Check job status.
- `GET /credits/balance`: Get current credit balance.
- `GET /admin/config`: Admin configuration.

## Credit Logic

- **Weekly Credits**: Reset every week based on subscription anchor.
- **Purchased Credits**: Never expire, used after weekly credits.
- **Ledger**: All changes are recorded in `credit_ledger`.

## Jobs

Jobs are processed asynchronously. Status flow: `created -> queued -> processing -> completed/failed`.
Outputs are mocked via `src/services/providers/mock.js`.
