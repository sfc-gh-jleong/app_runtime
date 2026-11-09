/**
 * Invoice ↔ Snowflake order reconciliation. Pure functions only, so the same code
 * runs in the compare route (live preview while editing) and again in the approve
 * route (the server never trusts a client-computed status).
 *
 * Lines are matched by SKU rather than line number, so a missing or extra line
 * does not shift every following line into a false mismatch.
 */
import { normalizeSku, round2 } from "./extract"
import type {
  Discrepancy,
  ExtractedInvoice,
  Issue,
  LineResult,
  ReconcileResult,
  ReferenceLookups,
  SnowflakeOrder,
  SnowflakeOrderLine,
} from "./invoice-types"

const CENT = 0.005

function sameMoney(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b
  return Math.abs(a - b) < CENT
}

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase()
}

const fmt = (n: number | null) => (n === null ? null : n.toFixed(2))

/** Net amount of an invoice line, preferring the printed amount. */
export function lineNet(line: ExtractedInvoice["lines"][number]): number | null {
  if (line.amount !== null) return line.amount
  if (line.quantity === null || line.unitPrice === null) return null
  return round2(line.quantity * line.unitPrice - (line.discount ?? 0))
}

/** Total as printed, or computed from lines + shipping when the total was not read. */
export function invoiceTotal(inv: ExtractedInvoice): number | null {
  if (inv.total !== null) return inv.total
  const nets = inv.lines.map(lineNet)
  if (nets.some((n) => n === null)) return null
  return round2((nets as number[]).reduce((s, n) => s + n, 0) + (inv.shipping ?? 0))
}

/** Arithmetic checks on the invoice itself (independent of Snowflake). */
function arithmeticIssues(inv: ExtractedInvoice): Issue[] {
  const issues: Issue[] = []
  for (const l of inv.lines) {
    if (l.quantity === null || l.unitPrice === null || l.amount === null) continue
    const expected = round2(l.quantity * l.unitPrice - (l.discount ?? 0))
    if (!sameMoney(expected, l.amount)) {
      issues.push({
        severity: "warning",
        field: `lines.${l.lineNumber}.amount`,
        message: `Line ${l.lineNumber}: ${l.quantity} × ${l.unitPrice.toFixed(2)} − ${(l.discount ?? 0).toFixed(2)} = ${expected.toFixed(2)}, but the invoice shows ${l.amount.toFixed(2)}`,
      })
    }
  }
  const nets = inv.lines.map(lineNet)
  if (inv.total !== null && nets.every((n) => n !== null)) {
    const computed = round2((nets as number[]).reduce((s, n) => s + n, 0) + (inv.shipping ?? 0))
    if (!sameMoney(computed, inv.total)) {
      issues.push({
        severity: "warning",
        field: "total",
        message: `Lines plus shipping add up to ${computed.toFixed(2)}, but the invoice total is ${inv.total.toFixed(2)}`,
      })
    }
  }
  return issues
}

function requiredFieldIssues(inv: ExtractedInvoice): Issue[] {
  const issues: Issue[] = []
  if (!inv.invoiceNumber) issues.push({ severity: "blocking", field: "invoiceNumber", message: "Invoice number is required" })
  if (!/^\d+$/.test(inv.orderId)) issues.push({ severity: "blocking", field: "orderId", message: "Order number must be a whole number" })
  if (inv.lines.length === 0) issues.push({ severity: "blocking", field: "lines", message: "The invoice has no line items" })
  return issues
}

/** Validate an invoice whose order does not exist yet (approval will create it). */
function reconcileNew(inv: ExtractedInvoice, refs: ReferenceLookups): ReconcileResult {
  const issues: Issue[] = [...requiredFieldIssues(inv), ...arithmeticIssues(inv)]
  if (!inv.orderDate) issues.push({ severity: "blocking", field: "orderDate", message: "Order date is required to create a new order" })
  if (inv.customerEmail && !refs.customerExists) {
    issues.push({ severity: "blocking", field: "customerEmail", message: `No customer has the email ${inv.customerEmail}` })
  }
  if (!refs.storeExists) {
    issues.push({ severity: "blocking", field: "storeName", message: `No store is named "${inv.storeName || "(blank)"}"` })
  }

  const lines: LineResult[] = inv.lines.map((l) => {
    const product = refs.products[normalizeSku(l.sku)]
    if (!product) {
      issues.push({ severity: "blocking", field: `lines.${l.lineNumber}.sku`, message: `Line ${l.lineNumber}: unknown SKU ${l.sku || "(blank)"}` })
      return { lineNumber: l.lineNumber, sku: l.sku, status: "NEW", snowflake: null, fields: ["sku"] }
    }
    const fields: string[] = []
    if (l.unitPrice !== null && !sameMoney(l.unitPrice, product.listPrice)) {
      fields.push("unitPrice")
      issues.push({
        severity: "warning",
        field: `lines.${l.lineNumber}.unitPrice`,
        message: `Line ${l.lineNumber}: unit price ${l.unitPrice.toFixed(2)} differs from list price ${product.listPrice.toFixed(2)}`,
      })
    }
    return { lineNumber: l.lineNumber, sku: l.sku, status: "NEW", snowflake: null, fields }
  })

  return {
    status: "NEW",
    discrepancies: [],
    issues,
    lines,
    missingLines: [],
    headerMismatches: [],
    invoiceTotal: invoiceTotal(inv),
    expectedTotal: null,
    varianceUsd: null,
  }
}

/** Compare an invoice with an existing Snowflake order. */
function reconcileExisting(inv: ExtractedInvoice, order: SnowflakeOrder): ReconcileResult {
  const discrepancies: Discrepancy[] = []
  const issues: Issue[] = [...requiredFieldIssues(inv), ...arithmeticIssues(inv)]
  const headerMismatches: string[] = []

  const header = (field: keyof ExtractedInvoice, label: string, invVal: string, sfVal: string | null, same: boolean, diff: number | null = null) => {
    if (same) return
    headerMismatches.push(field)
    discrepancies.push({ scope: "HEADER", lineNumber: null, field: label, invoiceValue: invVal || null, snowflakeValue: sfVal, differenceUsd: diff })
  }

  header("customerEmail", "customer_email", inv.customerEmail, order.customerEmail, sameText(inv.customerEmail, order.customerEmail))
  header("customerName", "customer_name", inv.customerName, order.customerName, sameText(inv.customerName, order.customerName))
  header("storeName", "store_name", inv.storeName, order.storeName, sameText(inv.storeName, order.storeName))
  header("orderDate", "order_date", inv.orderDate, order.orderDate, inv.orderDate === order.orderDate)
  header(
    "shipping",
    "shipping_usd",
    fmt(inv.shipping) ?? "",
    fmt(order.shipping),
    sameMoney(inv.shipping ?? 0, order.shipping),
    round2((inv.shipping ?? 0) - order.shipping),
  )

  if (order.orderStatus === "CANCELLED") {
    issues.push({ severity: "warning", field: "orderId", message: `Order ${order.orderId} is CANCELLED in Snowflake` })
  }
  if (order.isTestOrder) {
    issues.push({ severity: "warning", field: "orderId", message: `Order ${order.orderId} is flagged as a test order` })
  }

  // Match invoice lines to order lines by SKU (first unused match wins).
  const unused = [...order.lines]
  const lines: LineResult[] = inv.lines.map((l) => {
    const idx = unused.findIndex((s) => normalizeSku(s.sku) === normalizeSku(l.sku))
    if (idx === -1) {
      discrepancies.push({
        scope: "LINE",
        lineNumber: l.lineNumber,
        field: "extra_line",
        invoiceValue: l.sku,
        snowflakeValue: null,
        differenceUsd: lineNet(l),
      })
      return { lineNumber: l.lineNumber, sku: l.sku, status: "EXTRA", snowflake: null, fields: ["sku"] }
    }
    const sf = unused.splice(idx, 1)[0]
    const fields: string[] = []
    if (l.quantity !== sf.quantity) {
      fields.push("quantity")
      discrepancies.push({
        scope: "LINE",
        lineNumber: l.lineNumber,
        field: "quantity",
        invoiceValue: l.quantity === null ? null : String(l.quantity),
        snowflakeValue: String(sf.quantity),
        differenceUsd: l.quantity === null ? null : round2((l.quantity - sf.quantity) * (l.unitPrice ?? sf.unitPrice)),
      })
    }
    if (!sameMoney(l.unitPrice, sf.unitPrice)) {
      fields.push("unitPrice")
      discrepancies.push({
        scope: "LINE",
        lineNumber: l.lineNumber,
        field: "unit_price",
        invoiceValue: fmt(l.unitPrice),
        snowflakeValue: fmt(sf.unitPrice),
        differenceUsd: l.unitPrice === null ? null : round2((l.unitPrice - sf.unitPrice) * (l.quantity ?? sf.quantity)),
      })
    }
    if (!sameMoney(l.discount ?? 0, sf.discount)) {
      fields.push("discount")
      discrepancies.push({
        scope: "LINE",
        lineNumber: l.lineNumber,
        field: "discount_amount",
        invoiceValue: fmt(l.discount ?? 0),
        snowflakeValue: fmt(sf.discount),
        differenceUsd: round2(sf.discount - (l.discount ?? 0)),
      })
    }
    return { lineNumber: l.lineNumber, sku: l.sku, status: fields.length ? "MISMATCHED" : "MATCHED", snowflake: sf, fields }
  })

  for (const sf of unused) {
    discrepancies.push({
      scope: "LINE",
      lineNumber: sf.lineNumber,
      field: "missing_line",
      invoiceValue: null,
      snowflakeValue: sf.sku,
      differenceUsd: round2(-sf.net),
    })
  }

  const expectedTotal = round2(order.lines.reduce((s, l) => s + l.net, 0) + order.shipping)
  const total = invoiceTotal(inv)
  const varianceUsd = total === null ? null : round2(total - expectedTotal)
  if (varianceUsd === null || Math.abs(varianceUsd) >= CENT) {
    discrepancies.push({
      scope: "HEADER",
      lineNumber: null,
      field: "total_usd",
      invoiceValue: fmt(total),
      snowflakeValue: fmt(expectedTotal),
      differenceUsd: varianceUsd,
    })
    headerMismatches.push("total")
  }

  return {
    status: discrepancies.length ? "MISMATCHED" : "MATCHED",
    discrepancies,
    issues,
    lines,
    missingLines: unused,
    headerMismatches,
    invoiceTotal: total,
    expectedTotal,
    varianceUsd,
  }
}

export function reconcile(inv: ExtractedInvoice, order: SnowflakeOrder | null, refs: ReferenceLookups): ReconcileResult {
  return order ? reconcileExisting(inv, order) : reconcileNew(inv, refs)
}

export function hasBlockingIssues(result: ReconcileResult): boolean {
  return result.issues.some((i) => i.severity === "blocking")
}

export type { SnowflakeOrderLine }
