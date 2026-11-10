# Invoice Reconciliation on Snowflake App Runtime

Upload vendor invoice PDFs, extract them with **AI_EXTRACT**, reconcile them against Summit Outfitters orders in `SNOWFLAKE_DEMO.CORTEX_SENSE`, review and correct the values, and approve them into Snowflake. A chat popup (Cortex Agent SDK) answers questions about invoices and retail sales.

```
PDF ──upload──▶ @INVOICE_STAGE ──AI_EXTRACT──▶ review (editable, live compare vs ORDERS / ORDER_ITEMS)
                                                  │ approve
                                                  ▼
                       INVOICES · INVOICE_LINES · INVOICE_DISCREPANCIES  (+ ORDERS / ORDER_ITEMS for NEW)
                                                  │
                     chat ◀── SUMMIT_RETAIL_AGENT ─┤── INVOICE_RECON_SV (Cortex Analyst)
                                                   └── RETAIL_SALES (Cortex Sense)
```

## Repo layout

| Path | Contents |
|---|---|
| `invoice-app/` | Next.js app (`app.yml` v2 manifest). See [invoice-app/README.md](invoice-app/README.md) |
| `sql/` | Idempotent Snowflake setup, run in order (01–06) |
| `cortex_project/` | Source of truth for the `INVOICE_RECON_SV` semantic view and the `SUMMIT_RETAIL_AGENT` spec |
| `test_invoices/` | 15 generated test PDFs plus [EXPECTED_RESULTS.md](test_invoices/EXPECTED_RESULTS.md) |
| `scripts/generate_invoices.py` | Rebuilds the test PDFs from live order data |
| `scripts/e2e_check.sh` | Upload, extract and compare every test PDF against a running app (approves nothing) |
| `.github/workflows/` | `ci.yml` (PR checks) and `deploy.yml` (deploy on push to `main`) |

## Snowflake setup (`sql/`)

| Script | Creates |
|---|---|
| `01_role.sql` | `INVOICE_APP_ROLE`, the app's owner/execution role, with data, deploy, EAI and Cortex grants |
| `02_stage_tables.sql` | `INVOICE_STAGE` (SSE), `INVOICES`, `INVOICE_LINES`, `INVOICE_DISCREPANCIES` |
| `03_procs.sql` | `UPLOAD_INVOICE` (Python; writes the PDF to the stage) and `APPROVE_INVOICE` (SQL; one transaction, creates ORDERS/ORDER_ITEMS for NEW invoices) |
| `04_semantic_view.sql` | Grants on `INVOICE_RECON_SV` (deploy the view from `cortex_project/INVOICE_RECON_SV.sv.yaml`) |
| `05_agent.sql` | Grants for `SUMMIT_RETAIL_AGENT`. VERSION$2 of the agent adds the `invoice_reconciliation` analyst tool |
| `06_cicd_service_user.sql` | `GHA_INVOICE_APP_SVC`, the OIDC service user for GitHub Actions, plus its user-level network policy |

Run a script with `snow sql -c <key-pair connection> -f sql/0N_*.sql`. The account and connection used here: `SFSENORTHAMERICA-JLEONG_AWS1` with the `osm_deploy` key-pair connection.

## Test invoices

| Folder | Expected status | Purpose |
|---|---|---|
| `matching/` (5) | MATCHED | Exact copies of real orders |
| `mismatched/` (6) | MISMATCHED | One injected difference each: quantity, unit price, missing line, extra line, shipping, bill-to email |
| `new/` (4) | NEW | Orders 60001–60004, which don't exist yet. Approving one creates it. `INV-2026-060004.pdf` prints SKU `SKU-0O112` (letter O); correct it to `SKU-00112` in review, or approval is blocked |

Regenerate the PDFs with `uv run --with reportlab --with snowflake-connector-python scripts/generate_invoices.py --connection osm_deploy`. Re-run it after approving `new/` invoices, because those orders then exist.

## CI/CD (GitHub Actions + Snowflake OIDC)

- **`ci.yml`** runs on pull requests that touch `invoice-app/`: `npm ci`, typecheck, vitest, `next build`. It needs no Snowflake access.
- **`deploy.yml`** runs on push to `main` (paths `invoice-app/**`) or manually. It reuses `ci.yml` as a gate, then in the GitHub environment `prod` it runs `snowflakedb/snowflake-actions@v3` with `use-oidc: true`, followed by `snow connection test`, `snow app validate` and `snow app deploy`. The app URL goes to the run summary.
- **Authentication** is GitHub OIDC to Snowflake workload identity federation. No secrets are stored. The service user trusts exactly `repo:sfc-gh-jleong@204736462/app_runtime@1451879960:environment:prod` (this repo uses GitHub's immutable subject format).
- **Network:** the account policy `ACCOUNT_VPN_POLICY_SE` would block GitHub-hosted runners, so the service user has the user-level `GITHUB_ACTIONS_POLICY`. That policy allows the Snowflake-managed rule `SNOWFLAKE.NETWORK_SECURITY.GITHUBACTIONS_GLOBAL`.
- The workflow deploys as `INVOICE_APP_ROLE`, the role that owns the application service. A `version: 2` deploy needs ownership of the existing service.

To add a manual approval gate for production, add required reviewers to the `prod` environment under **Settings → Environments → prod**.

## The deployed app

`SNOWFLAKE_DEMO.CORTEX_SENSE.INVOICE_RECONCILIATION`: https://f6amnfod-sfsenorthamerica-jleong-aws1.snowflakecomputing.app

Share it with another role: `GRANT USAGE ON APPLICATION SERVICE SNOWFLAKE_DEMO.CORTEX_SENSE.INVOICE_RECONCILIATION TO ROLE <role>;`
