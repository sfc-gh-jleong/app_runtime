/** Coerce an untrusted request body into an ExtractedInvoice with bounded sizes. */
import { normalizeSku, parseDate, parseMoney, parseQuantity } from "./extract"
import type { ExtractedInvoice, InvoiceLine } from "./invoice-types"

const MAX_LINES = 200

function str(v: unknown, max = 200): string {
  return typeof v === "string" ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : ""
}

export function coerceInvoice(input: unknown): ExtractedInvoice {
  if (!input || typeof input !== "object") throw new Error("invoice must be an object")
  const o = input as Record<string, unknown>
  const rawLines = Array.isArray(o.lines) ? o.lines.slice(0, MAX_LINES) : []
  const lines: InvoiceLine[] = rawLines.map((raw, i) => {
    const l = (raw ?? {}) as Record<string, unknown>
    const discount = parseMoney(l.discount)
    return {
      lineNumber: parseQuantity(l.lineNumber) ?? i + 1,
      sku: normalizeSku(str(l.sku, 40)),
      description: str(l.description, 300),
      quantity: parseQuantity(l.quantity),
      unitPrice: parseMoney(l.unitPrice),
      discount: discount === null ? null : Math.abs(discount),
      amount: parseMoney(l.amount),
    }
  })
  const discountTotal = parseMoney(o.discountTotal)
  return {
    invoiceNumber: str(o.invoiceNumber, 60),
    orderId: str(o.orderId, 20).replace(/[^0-9]/g, ""),
    invoiceDate: parseDate(str(o.invoiceDate, 40)),
    orderDate: parseDate(str(o.orderDate, 40)),
    customerName: str(o.customerName),
    customerEmail: str(o.customerEmail).toLowerCase(),
    storeName: str(o.storeName),
    subtotal: parseMoney(o.subtotal),
    discountTotal: discountTotal === null ? null : Math.abs(discountTotal),
    shipping: parseMoney(o.shipping),
    total: parseMoney(o.total),
    lines,
  }
}
