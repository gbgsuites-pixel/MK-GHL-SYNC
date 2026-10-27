# Mary Kay InTouch — GoHighLevel Sync Server

A self-contained Node.js server that replaces the Google Apps Script hybrid architecture. All Mary Kay InTouch data fetching, processing, and GoHighLevel syncing happens directly on this server — no Google Apps Script required.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Render Node.js Server                         │
│                                                                  │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐ │
│  │ Puppeteer    │──▶│ Aura API     │──▶│ Data Processor       │ │
│  │ Login        │   │ (mkPage tab) │   │ (merge + dedup)      │ │
│  │ (Two Tabs)   │   └──────────────┘   └──────────┬───────────┘ │
│  │              │   ┌──────────────┐               │             │
│  │              │   │ LWR API      │──▶────────────┘             │ │
│  │              │   │ (appsPage    │                              │ │
│  │              │   │  + CDP)      │                              │ │
│  └──────────────┘   └──────────────┘                              │ │
│                      ▲                             │             │ │
│  ┌──────────────┐   │                     ┌───────┴───────────┐ │ │
│  │ HTTP API     │───┘                     │ JSON Config        │ │ │
│  │ Endpoints    │                         │ (multi-client)     │ │ │
│  └──────────────┘                         └────────────────────┘ │ │
│                                                                  │ │
│  ┌──────────────┐   ┌──────────────┐                             │ │
│  │ Cron         │──▶│ Orchestrator │──▶ GHL API Upload           │ │
│  │ Scheduler    │   │              │                             │ │
│  └──────────────┘   └──────────────┘                             │ │
└─────────────────────────────────────────────────────────────────┘
```

## Key Improvements Over Apps Script

| Issue | Apps Script (Old) | Node.js Server (New) |
|-------|-------------------|----------------------|
| Customer List failures | Cookie domain/security mismatch in time-driven triggers | CDP interception captures exact LWR request format — guaranteed 200 |
| Session management | Apps Script requests session from Render, gets cookies back | Server owns the full browser session — no inter-process cookie handoff |
| Multi-client support | Hardcoded in Apps Script | JSON config file — add clients by editing one file |
| Scheduling | Apps Script time-driven triggers (6-min limit) | node-cron with timezone support, no execution limits |
| Chunked GHL sync | Apps Script creates continuation triggers (fragile) | Server-side chunk processing with cursor tracking |
| Monitoring | No visibility | HTTP API for status, session health, and manual triggers |

## Architecture Details

### Two-Tab Browser Model

| Tab | Domain | Purpose | API Method |
|-----|--------|---------|------------|
| `mkPage` | `mk.marykayintouch.com` | Aura API calls | `page.evaluate()` fetch() — same-origin, cookies auto-sent |
| `appsPage` | `apps.marykayintouch.com` | LWR API calls | CDP Fetch interception + replay — captures exact auth headers |

### Why page.evaluate() for Aura API?

The mkPage stays on the mk domain, so `fetch()` calls are same-origin. The browser automatically sends cookies. This exactly replicates the Apps Script's `UrlFetchApp.fetch()` approach — no cookie extraction, no axios, no CORS issues.

### Why CDP Interception for LWR API?

The LWR API (`/webruntime/api/apex/execute`) requires exact header matching including `CSRF-Token` (Salesforce format), Zipkin tracing headers (`X-B3-*`, `X-SFDC-Request-Id`), and the full cookie string. Simple `fetch()` calls from `page.evaluate()` return 401 even with the same CSRF token. The solution: intercept the page's own natural LWR call during reload, capture the full request with all headers, then replay it.

### Data Flow

1. **Login** — Puppeteer logs in on `mk.marykayintouch.com`, extracts the Aura session token from `$A.clientService.Cc`
2. **SSO Navigation** — A second tab navigates to `apps.marykayintouch.com/customer-list` via SSO
3. **Aura API** (`mkPage`): `page.evaluate()` fetch() calls to `/s/sfsites/aura?r=1`
4. **LWR API** (`appsPage`): CDP captures the page's own `getRelatedCustomers` call, then replays it
5. **Merge** — Apps Script merge logic combines all 4 data sources into unified contacts
6. **GHL Upload** — Contacts are upserted to GoHighLevel via REST API

### Data Sources

| Data Source | API | Tab | Controller | Method | Records |
|-------------|-----|-----|------------|--------|---------|
| Consultant List | Aura API | mkPage | `CMT_ConsultantListController` | `getConsultantList` | ~86 |
| Sales Volume | Aura API | mkPage | `CMT_ProductionListController` | `getProductionListData` | ~12 |
| Star Consultant | Aura API | mkPage | `CMT_ProductionListController` | `getProductionListData` | ~12 |
| Customer List | LWR API | appsPage | `@udd/01pR30000011tgG` | `getRelatedCustomers` | ~547 |

All data is merged using the same logic as the original Google Apps Script.

## Quick Start

### Local Development

```bash
git clone <your-repo>
cd mk-ghl-sync
cp .env.example .env
npm install
npm start
```

### Render Deployment

1. **Create a new Web Service** on Render.com
2. **Set the Build Command:** `npm install`
3. **Set the Start Command:** `node src/server.js`
4. **Use the Dockerfile:** Select "Docker" as the runtime and point to the included `Dockerfile`

### Environment Variables (set in Render dashboard)

| Variable | Description | Example |
|----------|-------------|---------|
| `PORT` | Server port (Render sets this automatically) | `3000` |
| `API_SECRET_KEY` | Secret key for API authentication | `your-secret-key-here` |
| `CLIENTS_CONFIG_JSON` | Secret-managed JSON containing client credentials and field mappings | runtime secret only |
| `CONFIG_PATH` | External path to the clients config file; do not point production at the repository file | runtime-injected path |
| `REQUIRE_EXTERNAL_CLIENT_CONFIG` | Reject repository-bundled credentials when true | `true` in production |
| `FRONTEND_ORIGINS` | Comma-separated exact dashboard origins allowed by CORS | runtime setting |
| `SCHEDULE_CONFIG_PATH` | Writable schedule state path when clients are loaded from secret JSON | `./runtime/schedule.json` |
| `MANAGED_CLIENTS_ENABLED` | Enable encrypted Supabase-backed client management after migration | `false` |
| `CLIENT_SECRET_ENCRYPTION_KEY` | Runtime-only key used to encrypt Mary Kay/GHL credentials at rest | secret |
| `LOG_LEVEL` | Logging verbosity | `info` |
| `GHL_CHUNK_SIZE` | Contacts per GHL API batch | `50` |
| `SESSION_TTL_HOURS` | Session cache duration | `23` |
| `PUPPETEER_EXECUTABLE_PATH` | Chromium path (Render Docker) | `/usr/bin/chromium` |

## Configuration

### Adding Clients

For local development only, copy `config/clients.example.json` to the ignored
`config/clients.json` and add an entry to the `clients` array. Production
managed mode does not read this file or any JSON client configuration; all
clients and encrypted credentials come directly from Supabase.

```json
{
  "consultantNum": "AB1234",
  "password": "your-password",
  "clientName": "Client Name",
  "ghlApiToken": "pit-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "ghlLocationId": "xxxxxxxxxxxxxxxxxxxxxx",
  "ghlCustomFields": {
    "Career Level": "fieldId1",
    "Activity Status": "fieldId2"
  }
}
```

### Schedule Configuration

Edit the `_serverConfig` section in `config/clients.json`:

```json
"_serverConfig": {
  "schedule": {
    "enabled": true,
    "cron": "30 0 * * *",
    "timezone": "America/Chicago"
  }
}
```

After editing config, restart the server or call `POST /api/config/reload`.

### Supabase-managed clients

Phase 2 adds encrypted client management in `migrations/VA-3379 - integration_clients.sql`.
Run that migration in the Supabase SQL editor, set `SUPABASE_URL`, `SUPABASE_KEY`,
`CLIENT_SECRET_ENCRYPTION_KEY`, and `MANAGED_CLIENTS_ENABLED=true`, then restart
the backend. The service hydrates the managed client records before starting
cron. Passwords and GHL private integration keys are encrypted with AES-256-GCM
before being written to Supabase and are never returned to the frontend.

Apply the following additive column if it is not already present before deploying
the current build:

```sql
alter table public.integration_clients
  add column if not exists last_sync_stats jsonb not null default '{}'::jsonb;
```

Managed mode fails closed if Supabase cannot be initialized or the client table
cannot be queried. It will not start with an empty legacy client list and will
not silently display zero clients after a hydration failure. Check Render logs
for `[Supabase] Hydrated N managed client(s).` after deployment.

Managed startup probes `integration_clients` directly; the optional
`server_logs` table is not required for client hydration. If one imported row
cannot be decrypted, the remaining clients still load and that row is marked
`CREDENTIAL_DECRYPTION_FAILED`/`invalid` until its credentials are replaced.

The managed lifecycle endpoints are:

```text
GET    /api/v1/clients
GET    /api/v1/clients/:id
POST   /api/v1/clients
POST   /api/v1/clients/:id/validate-credentials
PATCH  /api/v1/clients/:id/status
DELETE /api/v1/clients/:id       # soft-disconnects; it does not hard-delete history
DELETE /api/v1/clients/:id/permanent # removes the integration row; history remains
POST   /api/v1/clients/:id/sync
```

Creating a client requires `clientName`, `consultantNum`, `password`,
`ghlApiToken`, and `ghlLocationId`. The create endpoint performs a read-only
GoHighLevel custom-field lookup and stores the returned name-to-ID map with the
encrypted client record. New clients start as `pending_validation`; use the
validation action to run the read-only Mary Kay session check. Only `active`
clients participate in manual full syncs and scheduled syncs. `paused`,
`invalid`, `disconnected`, and `removal_pending` clients are excluded.

### Protected custom-field safety guard

The sync performs a read-only GHL custom-field preflight for these protected
fields before any contact upload:

```text
Activity Status
Current Wholesale
Career Level
Client Last Order
Needed for Sapphire
Needed for Ruby
Needed for Diamond
Needed for Emerald
Needed for Pearl
```

If a protected field is missing from the stored mapping, missing from the live
GHL location, or its mapping ID changed, the client sync is blocked before GHL
upload. The service also compares protected-field source availability with the
previous sync and blocks when a previously populated field suddenly returns no
values. The affected field names are recorded as critical logs and shown in
the dashboard client error/details panels. A successful subsequent sync clears
the prior alert.

### Structured operational logs

Apply `migrations/VA-3379 - structured_log_events.sql` to add filterable event
fields to the existing `server_logs` table. The logger writes redacted JSONL
events with an event ID, timestamp, level, category, client/execution context,
operation, status, error code, retryability, and bounded metadata. Local files
rotate by UTC date, and Supabase log batches are serialized, retried, and
drained during shutdown. If the additive migration has not reached a rolling
instance yet, the writer falls back to the legacy timestamp/level/message
columns rather than dropping the event.

The dashboard can query durable events through:

```text
GET /api/v1/log-events?limit=200&level=error&category=upload&status=failed&retryable=true&clientId=...&executionId=...&since=...&until=...
```

All filters are validated and bounded. The legacy `/api/logs/recent` endpoint
remains available and now uses the same structured/local fallback path.

### Supabase client runtime

The backend only reads encrypted managed clients from the existing
`integration_clients` table. Client-data conversion is intentionally kept out
of this repository. Use the separately delivered standalone converter
`VA-3379 - clients.json to Supabase SQL.js` to generate an import SQL file
locally. The converter never contacts Supabase, rejects non-identical duplicate
identities, collapses exact duplicates, and encrypts Mary Kay/GHL credentials
with `CLIENT_SECRET_ENCRYPTION_KEY` before writing SQL. Run the generated SQL
once in the Supabase SQL Editor, then configure the same permanent encryption
key in the backend runtime.

## API Endpoints

All REST endpoints (except `/health`) require the `x-api-key` header matching
`API_SECRET_KEY`. Log and progress SSE streams require a short-lived ticket
obtained from `POST /api/stream-ticket`; long-lived API keys are never placed
in stream URLs. Query-string API-key compatibility is disabled by default and
should remain disabled in production.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check (no auth) |
| GET | `/api/clients` | List all configured clients |
| POST | `/api/sync/all` | Trigger full sync for all clients |
| POST | `/api/sync/:consultantNum` | Trigger sync for a single client |
| GET | `/api/status` | Get current execution state |
| GET | `/api/sessions` | Get session cache status |
| POST | `/api/sessions/refresh/:consultantNum` | Force-refresh a session |
| POST | `/api/config/reload` | Reload config from disk |
| GET | `/api/config/schedule` | Get schedule configuration |
| GET | `/api/diagnostic/raw/:consultantNum` | Fetch raw Mary Kay data |
| GET | `/api/diagnostic/processed/:consultantNum` | Fetch GHL-ready contacts |
| GET | `/api/diagnostic/validate/:consultantNum` | Run data validation |
| GET | `/api/export/lists/:consultantNum` | Export raw lists as JSON |
| GET | `/api/export/ghl-contacts/:consultantNum` | Export GHL contacts as JSON |
| GET | `/api/export/ghl-csv/:consultantNum` | Export GHL contacts as CSV download |
| POST | `/api/stream-ticket` | Exchange the API key for a short-lived logs/progress SSE ticket |

### Example API Calls

```bash
# Check health
curl http://your-server.render.com/health

# List clients
curl -H "x-api-key: your-secret-key" http://your-server.render.com/api/clients

# Trigger sync for all clients
curl -X POST -H "x-api-key: your-secret-key" http://your-server.render.com/api/sync/all

# Trigger sync for a specific client
curl -X POST -H "x-api-key: your-secret-key" http://your-server.render.com/api/sync/JA7516

# Check sync status
curl -H "x-api-key: your-secret-key" http://your-server.render.com/api/status

# Force-refresh a session
curl -X POST -H "x-api-key: your-secret-key" http://your-server.render.com/api/sessions/refresh/JA7516

# Fetch raw diagnostic data
curl -H "x-api-key: your-secret-key" http://your-server.render.com/api/diagnostic/raw/JA7516
```

## Testing

```bash
# Run E2E test (validates all 4 data lists)
node test-e2e-v4.js
```

## File Structure

```
mk-ghl-sync/
├── Dockerfile              # Docker configuration for Render
├── package.json            # Dependencies
├── .env.example            # Environment variable template
├── config/
│   └── clients.json        # Multi-client configuration
├── src/
│   ├── server.js           # Express server entry point
│   ├── core/
│   │   ├── config.js       # Configuration loader
│   │   ├── auraApi.js      # mk.marykayintouch.com Aura API (page.evaluate)
│   │   └── lwrApi.js       # apps.marykayintouch.com LWR API (CDP replay)
│   ├── sessions/
│   │   └── sessionManager.js  # Puppeteer login + two-tab session cache
│   ├── processors/
│   │   ├── dataProcessor.js   # Data fetching, merging, GHL contact building
│   │   └── diagnostics.js     # Raw data export + validation
│   ├── sync/
│   │   └── ghlSync.js      # Chunked GHL contact upload
│   ├── scheduler/
│   │   ├── orchestrator.js # Full sync workflow coordinator
│   │   └── cron.js         # node-cron scheduler
│   ├── api/
│   │   └── routes.js       # HTTP API endpoints
│   └── utils/
│       ├── logger.js       # Structured logging
│       └── dataHelpers.js  # Phone/date/address formatting
├── test-e2e-v4.js          # End-to-end test (all 4 data lists)
└── logs/                   # Log files (created automatically)
```

## Why This Architecture Is More Reliable

1. **No cookie handoff** — Puppeteer owns the full browser session. All API calls (Aura and LWR) use the same cookie jar from the same browser instance, guaranteeing perfect cookie transmission.

2. **No Apps Script limitations** — The 6-minute execution limit, `UrlFetchApp` cookie stripping, and time-driven trigger environment differences are eliminated entirely.

3. **Unified session** — There is no separate "session service" and "sync service." One process handles login, data fetching, processing, and uploading.

4. **CDP-based LWR API** — The Customer List LWR API call uses Chrome DevTools Protocol to capture and replay the page's own authenticated request, ensuring exact header matching (CSRF-Token, Zipkin tracing, full cookies).

5. **Retry logic** — The LWR API call includes automatic session invalidation and retry on 401 failure, matching the Apps Script's manual-retry behavior but now working automatically in scheduled mode.

6. **No trigger chains** — The Apps Script's fragile continuation trigger system (for chunked GHL sync) is replaced with server-side chunk processing that has no timeout constraints.
