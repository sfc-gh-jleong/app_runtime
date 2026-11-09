/**
 * AI_EXTRACT request shape and response normalisation.
 *
 * The response format mixes entity questions with one table (line items). It was
 * smoke-tested against the generated Summit Outfitters invoices: money comes back
 * as printed strings ("$1,013.56", "-$4.62"), so everything is parsed here.
 */
import type { ExtractedInvoice, ExtractionScores, InvoiceLine } from "./invoice-types"

export const INVOICE_STAGE = "@SNOWFLAKE_DEMO.CORTEX_SENSE.INVOICE_STAGE"

const entity = (description: string) => ({ description, type: "string" })
const column = (description: string) => ({ description, type: "array" })

export const LINE_COLUMNS = ["line", "sku", "description", "qty", "unit_price", "discount", "amount"] as const

export const RESPONSE_FORMAT = {
  schema: {
    type: "object",
    properties: {
      invoice_number: entity("What is the invoice number?"),
      order_number: entity("What is the order number?"),
      invoice_date: entity("What is the invoice date?"),
      order_date: entity("What is the order date?"),
      customer_name: entity("What is the bill-to customer name?"),
      customer_email: entity("What is the bill-to customer email address?"),
      store_name: entity("What is the store name?"),
      subtotal: entity("What is the subtotal amount?"),
      discount_total: entity("What is the total discount amount?"),
      shipping: entity("What is the shipping amount?"),
      total_due: entity("What is the total due?"),
      line_items: {
        description: "Invoice line items table",
        type: "object",
        column_ordering: [...LINE_COLUMNS],
        properties: {
          line: column("Line"),
          sku: column("SKU"),
          description: column("Description"),
          qty: column("Qty"),
          unit_price: column("Unit Price"),
          discount: column("Discount"),
          amount: column("Amount"),
        },
      },
    },
  },
}

/** Path written by UPLOAD_INVOICE: <32 hex>/<safe name>.pdf. Anything else is rejected. */
export const STAGE_PATH_RE = /^[0-9a-f]{32}\/[A-Za-z0-9._-]{1,124}\.pdf$/i

export function isValidStagePath(path: unknown): path is string {
  return typeof path === "string" && STAGE_PATH_RE.test(path)
}

const EMPTY = new Set(["", "none", "null", "n/a", "na", "-"])

function text(value: unknown): string {
  if (value === null || value === undefined) return ""
  const s = String(value).trim()
  return EMPTY.has(s.toLowerCase()) ? "" : s
}

/** "$1,013.56" -> 1013.56, "(4.62)" -> -4.62, "" -> null. */
export function parseMoney(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? round2(value) : null
  const s = text(value)
  if (!s) return null
  const negative = /^\(.*\)$/.test(s) || s.includes("-")
  const digits = s.replace(/[^0-9.]/g, "")
  if (!digits || digits === ".") return null
  const n = Number(digits)
  if (!Number.isFinite(n)) return null
  return round2(negative ? -n : n)
}

export function parseQuantity(value: unknown): number | null {
  const s = text(value).replace(/,/g, "")
  if (!s) return null
  const n = Number(s.replace(/[^0-9.-]/g, ""))
  return Number.isFinite(n) ? n : null
}

/** Accepts YYYY-MM-DD, MM/DD/YYYY and natural dates; returns YYYY-MM-DD or the raw text. */
export function parseDate(value: unknown): string {
  const s = text(value)
  if (!s) return ""
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10)
}

export function normalizeSku(value: unknown): string {
  return text(value).toUpperCase().replace(/\s+/g, "")
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export interface NormalizedExtraction {
  invoice: ExtractedInvoice
  scores: ExtractionScores
  error: string | null
}

/** Convert the AI_EXTRACT JSON ({response, scoring, error}) into an ExtractedInvoice. */
export function normalizeExtraction(raw: unknown): NormalizedExtraction {
  const obj = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, any> | null
  const r = (obj?.response ?? {}) as Record<string, any>
  const table = (r.line_items ?? {}) as Record<string, unknown[]>
  const rowCount = Math.max(0, ...LINE_COLUMNS.map((c) => (Array.isArray(table[c]) ? table[c].length : 0)))

  const lines: InvoiceLine[] = []
  for (let i = 0; i < rowCount; i++) {
    const cell = (c: (typeof LINE_COLUMNS)[number]) => (Array.isArray(table[c]) ? table[c][i] : undefined)
    const sku = normalizeSku(cell("sku"))
    const description = text(cell("description"))
    // Skip blank rows the model sometimes emits for table padding.
    if (!sku && !description) continue
    const discount = parseMoney(cell("discount"))
    lines.push({
      lineNumber: parseQuantity(cell("line")) ?? lines.length + 1,
      sku,
      description,
      quantity: parseQuantity(cell("qty")),
      unitPrice: parseMoney(cell("unit_price")),
      discount: discount === null ? null : Math.abs(discount),
      amount: parseMoney(cell("amount")),
    })
  }

  const discountTotal = parseMoney(r.discount_total)
  const invoice: ExtractedInvoice = {
    invoiceNumber: text(r.invoice_number),
    orderId: text(r.order_number).replace(/[^0-9]/g, ""),
    invoiceDate: parseDate(r.invoice_date),
    orderDate: parseDate(r.order_date),
    customerName: text(r.customer_name),
    customerEmail: text(r.customer_email).toLowerCase(),
    storeName: text(r.store_name),
    subtotal: parseMoney(r.subtotal),
    // Printed as "-$4.62"; stored as a positive discount amount.
    discountTotal: discountTotal === null ? null : Math.abs(discountTotal),
    shipping: parseMoney(r.shipping),
    total: parseMoney(r.total_due),
    lines,
  }

  const scores: ExtractionScores = {}
  const rawScores = (obj?.scoring?.scores ?? {}) as Record<string, { score?: number }>
  for (const [k, v] of Object.entries(rawScores)) {
    if (typeof v?.score === "number") scores[k] = v.score
  }

  return { invoice, scores, error: obj?.error ? String(obj.error) : null }
}
