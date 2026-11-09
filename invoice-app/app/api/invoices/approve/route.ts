/**
 * POST /api/invoices/approve  { invoice, filePath, fileName, extracted, editedFields }
 * Re-runs the reconciliation server-side (never trusts the client's status), then
 * persists through APPROVE_INVOICE, which also creates ORDERS / ORDER_ITEMS for NEW.
 */
import { headers } from "next/headers"
import { coerceInvoice } from "@/lib/coerce"
import { isValidStagePath } from "@/lib/extract"
import { approveInvoice, buildApprovePayload, compareInvoice, currentUser } from "@/lib/invoice-data"
import { hasBlockingIssues } from "@/lib/reconcile"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  let body: Record<string, unknown>
  let invoice
  try {
    body = (await req.json()) as Record<string, unknown>
    invoice = coerceInvoice(body.invoice)
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Invalid request" }, { status: 400 })
  }
  if (!isValidStagePath(body.filePath)) {
    return Response.json({ error: "Invalid file path" }, { status: 400 })
  }

  try {
    const { result } = await compareInvoice(invoice)
    if (hasBlockingIssues(result)) {
      return Response.json(
        { ok: false, errors: result.issues.filter((i) => i.severity === "blocking").map((i) => i.message), result },
        { status: 422 },
      )
    }
    const editedFields = Array.isArray(body.editedFields)
      ? body.editedFields.filter((f): f is string => typeof f === "string").slice(0, 100)
      : []
    const payload = buildApprovePayload(
      {
        invoice,
        filePath: body.filePath,
        fileName: typeof body.fileName === "string" ? body.fileName.slice(0, 200) : "",
        extracted: body.extracted ?? null,
        editedFields,
        approvedBy: currentUser(await headers()),
      },
      result,
    )
    const outcome = await approveInvoice(payload)
    if (!outcome?.ok) {
      return Response.json({ ok: false, errors: outcome?.errors ?? ["Approval failed"], result }, { status: 422 })
    }
    return Response.json({ ...outcome, result })
  } catch (e) {
    console.error(new Date().toISOString(), "[approve] failed", e)
    return Response.json({ ok: false, errors: [e instanceof Error ? e.message : "Approval failed"] }, { status: 500 })
  }
}
