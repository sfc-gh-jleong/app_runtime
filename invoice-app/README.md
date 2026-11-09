# Invoice Reconciliation (Snowflake App Runtime)

A Next.js app, deployed as the application service `SNOWFLAKE_DEMO.CORTEX_SENSE.INVOICE_RECONCILIATION`, for processing Summit Outfitters vendor invoices:

1. **Upload** a PDF (up to 10 MB). It is stored on `@SNOWFLAKE_DEMO.CORTEX_SENSE.INVOICE_STAGE` by the `UPLOAD_INVOICE` procedure.
2. **Extract** header fields and the line-item table with `AI_EXTRACT` (including per-field confidence scores).
3. **Compare** the extraction with `ORDERS` / `ORDER_ITEMS` / `CUSTOMERS` / `STORES` / `PRODUCTS`. Lines are matched by SKU, and the result is `MATCHED`, `MISMATCHED`, or `NEW` (the order does not exist yet).
4. **Review**: every field is editable, the Snowflake value is shown beside each field, and the comparison re-runs as you type. Edited fields are tracked.
5. **Approve**: the server re-runs the comparison and calls `APPROVE_INVOICE`, which writes `INVOICES`, `INVOICE_LINES` and `INVOICE_DISCREPANCIES`. For a `NEW` invoice it also creates the order in `ORDERS` / `ORDER_ITEMS`, in one transaction.
6. **Chat**: a floating popup talks to `SNOWFLAKE_DEMO.CORTEX_SENSE.SUMMIT_RETAIL_AGENT` through the Cortex Agent SDK (`@snowflake/cortex-agent-sdk`). The agent answers invoice questions from the `INVOICE_RECON_SV` semantic view and retail questions from the `RETAIL_SALES` Cortex Sense context. Conversations are Snowflake threads, so follow-up questions keep their context.

All queries run with **owner's rights** as `INVOICE_APP_ROLE`. The approver's name comes from the `Sf-Context-Current-User` ingress header.

## Data sources

| Object | Use |
|---|---|
| `ORDERS`, `ORDER_ITEMS`, `CUSTOMERS`, `STORES`, `PRODUCTS` | Reconciliation source of truth; `ORDERS`/`ORDER_ITEMS` receive new orders |
| `INVOICES`, `INVOICE_LINES`, `INVOICE_DISCREPANCIES` | Approved invoices (created by `../sql/02_stage_tables.sql`) |
| `INVOICE_STAGE` | Uploaded PDFs (`<uuid>/<file>.pdf`, SSE-encrypted for AI_EXTRACT) |
| `UPLOAD_INVOICE`, `APPROVE_INVOICE` | Owner's-rights procedures (`../sql/03_procs.sql`) |
| `INVOICE_RECON_SV`, `SUMMIT_RETAIL_AGENT` | Chat (`../sql/04_*.sql`, `../sql/05_*.sql`) |

## Key files

| Path | What it does |
|---|---|
| `lib/extract.ts` | AI_EXTRACT response format + normaliser (money/date parsing, stage-path validation) |
| `lib/reconcile.ts` | Pure reconciliation engine (header, SKU-matched lines, totals, NEW-order validation) |
| `lib/invoice-data.ts` | Server-side Snowflake reads, approve payload, `APPROVE_INVOICE` call |
| `lib/agent.ts` | Cortex Agent SDK client and authenticator (service token / PAT / key-pair JWT) |
| `app/api/invoices/*` | `upload`, `extract`, `compare`, `approve`, list, detail |
| `app/api/chat` | Streams an agent turn to the browser as SSE |
| `components/invoices/*` | Workbench (upload → review → approve), review panel, history |
| `components/chat/chat-widget.tsx` | Floating chat popup |

## Run locally

Requires Node 22.22 or later (the Agent SDK's minimum).

```bash
npm install
SNOWFLAKE_CONNECTION_NAME=osm_deploy SNOWFLAKE_ROLE=INVOICE_APP_ROLE SNOWFLAKE_WAREHOUSE=COMPUTE_WH npm run dev
```

- Use a **key-pair** `snow` connection. The chat mints a key-pair JWT from that connection's `private_key_file`. You can set `SNOWFLAKE_PAT` instead.
- `SNOWFLAKE_ROLE=INVOICE_APP_ROLE` runs the queries with the same grants the deployed app has.
- Smoke checks: `curl localhost:3000/`, `curl localhost:3000/api/stats`, and a `/_next/static/chunks/*.js` URL should all return 200.
- End-to-end check over every test PDF (upload, extract, compare; nothing is approved): `../scripts/e2e_check.sh http://localhost:3000`

Do **not** preview with `node .next/standalone/server.js`. That is the deploy artifact and does not serve static assets.

## Test

```bash
npm test          # vitest: extraction normaliser, reconciliation, approve route
npm run typecheck
```

`__tests__/lib/snowflake.test.ts` (from the template) fails if `SNOWFLAKE_DEFAULT_CONNECTION_NAME` is set in your shell. Unset it before running the tests.

## Deploy

`app.yml` is a `version: 2` manifest: database `SNOWFLAKE_DEMO`, schema `CORTEX_SENSE`, warehouse `COMPUTE_WH`, and build EAI `GHA_APP_NPM_EAI` (npm egress for `npm ci`, which runs inside Snowflake).

```bash
snow app deploy -c osm_deploy --role INVOICE_APP_ROLE --verbose
snow app open -c osm_deploy --role INVOICE_APP_ROLE --print-only
```

Always deploy with `INVOICE_APP_ROLE`. The deploying role becomes the service's execution role, and it cannot be changed later. Pushes to `main` deploy automatically through GitHub Actions (see the repo README).

Notes:
- A `version: 2` deploy is declarative. An `ALTER APPLICATION SERVICE ... SET` change is reverted on the next deploy unless it is also in `app.yml`.
- `NODE_ENV` cannot be set in `environment_variables`.
- To give other roles access: `GRANT USAGE ON APPLICATION SERVICE SNOWFLAKE_DEMO.CORTEX_SENSE.INVOICE_RECONCILIATION TO ROLE <role>`.
