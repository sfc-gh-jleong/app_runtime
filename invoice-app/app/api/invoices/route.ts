/**
 * GET /api/invoices?status=MATCHED|MISMATCHED|NEW
 * Most recent approved invoices (max 200).
 */
import { querySnowflake } from "@/lib/snowflake"
import { SCHEMA } from "@/lib/invoice-data"

export const dynamic = "force-dynamic"

const STATUSES = new Set(["MATCHED", "MISMATCHED", "NEW"])

export async function GET(req: Request) {
  const status = new URL(req.url).searchParams.get("status")?.toUpperCase() ?? ""
  const filter = STATUSES.has(status) ? status : null
  try {
    const rows = await querySnowflake(
      `SELECT INVOICE_ID, INVOICE_NUMBER, ORDER_ID, TO_VARCHAR(INVOICE_DATE, 'YYYY-MM-DD') AS INVOICE_DATE,
              CUSTOMER_NAME, CUSTOMER_EMAIL, STORE_NAME, TOTAL_USD::FLOAT AS TOTAL_USD, MATCH_STATUS,
              DISCREPANCY_COUNT, VARIANCE_USD::FLOAT AS VARIANCE_USD, ORDER_CREATED, FILE_NAME, APPROVED_BY,
              TO_VARCHAR(APPROVED_AT, 'YYYY-MM-DD"T"HH24:MI:SS') AS APPROVED_AT,
              ARRAY_SIZE(EDITED_FIELDS) AS EDITED_COUNT
       FROM ${SCHEMA}.INVOICES
       WHERE (? IS NULL OR MATCH_STATUS = ?)
       ORDER BY APPROVED_AT DESC
       LIMIT 200`,
      { binds: [filter, filter] },
    )
    return Response.json(rows)
  } catch (e) {
    console.error(new Date().toISOString(), "[invoices] list failed", e)
    return Response.json({ error: e instanceof Error ? e.message : "Failed to load invoices" }, { status: 500 })
  }
}
