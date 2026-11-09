/** GET /api/invoices/:id — lines, discrepancies and edited fields for one approved invoice. */
import { querySnowflake } from "@/lib/snowflake"
import { SCHEMA } from "@/lib/invoice-data"

export const dynamic = "force-dynamic"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  if (!UUID_RE.test(id)) return Response.json({ error: "Invalid invoice id" }, { status: 400 })
  try {
    const [lines, discrepancies, header] = await Promise.all([
      querySnowflake(
        `SELECT LINE_NUMBER, SKU, DESCRIPTION, QUANTITY, UNIT_PRICE::FLOAT AS UNIT_PRICE,
                DISCOUNT_AMOUNT::FLOAT AS DISCOUNT_AMOUNT, LINE_AMOUNT::FLOAT AS LINE_AMOUNT, LINE_STATUS
         FROM ${SCHEMA}.INVOICE_LINES WHERE INVOICE_ID = ? ORDER BY LINE_NUMBER`,
        { binds: [id] },
      ),
      querySnowflake(
        `SELECT SCOPE, LINE_NUMBER, FIELD_NAME, INVOICE_VALUE, SNOWFLAKE_VALUE, DIFFERENCE_USD::FLOAT AS DIFFERENCE_USD
         FROM ${SCHEMA}.INVOICE_DISCREPANCIES WHERE INVOICE_ID = ? ORDER BY SCOPE, LINE_NUMBER, FIELD_NAME`,
        { binds: [id] },
      ),
      querySnowflake(
        `SELECT EDITED_FIELDS::STRING AS EDITED_FIELDS, SUBTOTAL_USD::FLOAT AS SUBTOTAL_USD,
                DISCOUNT_USD::FLOAT AS DISCOUNT_USD, SHIPPING_USD::FLOAT AS SHIPPING_USD, FILE_PATH
         FROM ${SCHEMA}.INVOICES WHERE INVOICE_ID = ?`,
        { binds: [id] },
      ),
    ])
    if (!header[0]) return Response.json({ error: "Invoice not found" }, { status: 404 })
    return Response.json({
      lines,
      discrepancies,
      editedFields: JSON.parse(header[0].EDITED_FIELDS ?? "[]"),
      subtotal: header[0].SUBTOTAL_USD,
      discount: header[0].DISCOUNT_USD,
      shipping: header[0].SHIPPING_USD,
    })
  } catch (e) {
    console.error(new Date().toISOString(), "[invoices] detail failed", e)
    return Response.json({ error: e instanceof Error ? e.message : "Failed to load invoice" }, { status: 500 })
  }
}
