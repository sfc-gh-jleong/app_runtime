/** GET /api/stats — headline counts for the stat cards. */
import { querySnowflake } from "@/lib/snowflake"
import { SCHEMA } from "@/lib/invoice-data"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const [row] = await querySnowflake(
      `SELECT COUNT(*) AS TOTAL,
              COUNT_IF(MATCH_STATUS = 'MATCHED') AS MATCHED,
              COUNT_IF(MATCH_STATUS = 'MISMATCHED') AS MISMATCHED,
              COUNT_IF(MATCH_STATUS = 'NEW') AS NEW,
              COALESCE(SUM(TOTAL_USD), 0)::FLOAT AS INVOICED_USD,
              COALESCE(SUM(ABS(VARIANCE_USD)), 0)::FLOAT AS ABS_VARIANCE_USD,
              COUNT_IF(ORDER_CREATED) AS ORDERS_CREATED
       FROM ${SCHEMA}.INVOICES`,
    )
    return Response.json({
      total: Number(row?.TOTAL ?? 0),
      matched: Number(row?.MATCHED ?? 0),
      mismatched: Number(row?.MISMATCHED ?? 0),
      new: Number(row?.NEW ?? 0),
      invoicedUsd: Number(row?.INVOICED_USD ?? 0),
      absVarianceUsd: Number(row?.ABS_VARIANCE_USD ?? 0),
      ordersCreated: Number(row?.ORDERS_CREATED ?? 0),
    })
  } catch (e) {
    console.error(new Date().toISOString(), "[stats] failed", e)
    return Response.json({ error: e instanceof Error ? e.message : "Failed to load stats" }, { status: 500 })
  }
}
