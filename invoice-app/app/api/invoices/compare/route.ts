/**
 * POST /api/invoices/compare  { invoice }
 * Reconciles an (optionally edited) invoice against ORDERS / ORDER_ITEMS. Called on
 * every edit during review so the match badges stay live.
 */
import { coerceInvoice } from "@/lib/coerce"
import { compareInvoice } from "@/lib/invoice-data"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  let invoice
  try {
    invoice = coerceInvoice(((await req.json()) as { invoice?: unknown }).invoice)
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Invalid invoice" }, { status: 400 })
  }
  try {
    return Response.json(await compareInvoice(invoice))
  } catch (e) {
    console.error(new Date().toISOString(), "[compare] failed", e)
    return Response.json({ error: e instanceof Error ? e.message : "Comparison failed" }, { status: 500 })
  }
}
