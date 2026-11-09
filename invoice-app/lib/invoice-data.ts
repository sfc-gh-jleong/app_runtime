/**
 * Server-only Snowflake reads/writes for the invoice workflow. Every user-supplied
 * value is passed as a bind parameter; dates are cast to strings in SQL so the SDK
 * never hands back Date objects (see README "API route pitfalls").
 */
import { querySnowflake } from "@/lib/snowflake"
import { normalizeSku } from "./extract"
import type { ExtractedInvoice, ReconcileResult, ReferenceLookups, SnowflakeOrder } from "./invoice-types"
import { lineNet, reconcile } from "./reconcile"

export const SCHEMA = "SNOWFLAKE_DEMO.CORTEX_SENSE"

const ORDER_SQL = `
SELECT o.ORDER_ID, TO_VARCHAR(o.ORDER_DATE, 'YYYY-MM-DD') AS ORDER_DATE, o.ORDER_STATUS, o.IS_TEST_ORDER,
       o.SHIPPING_USD::FLOAT AS SHIPPING_USD,
       c.FIRST_NAME || ' ' || c.LAST_NAME AS CUSTOMER_NAME, c.EMAIL AS CUSTOMER_EMAIL, s.STORE_NAME
FROM ${SCHEMA}.ORDERS o
LEFT JOIN ${SCHEMA}.CUSTOMERS c ON c.CUSTOMER_ID = o.CUSTOMER_ID
LEFT JOIN ${SCHEMA}.STORES s ON s.STORE_ID = o.STORE_ID
WHERE o.ORDER_ID = ?`

const ORDER_LINES_SQL = `
SELECT i.LINE_NUMBER, p.SKU, p.PRODUCT_NAME, i.QUANTITY, i.UNIT_PRICE::FLOAT AS UNIT_PRICE,
       i.DISCOUNT_AMOUNT::FLOAT AS DISCOUNT_AMOUNT, (i.GROSS_SALES - i.DISCOUNT_AMOUNT)::FLOAT AS NET
FROM ${SCHEMA}.ORDER_ITEMS i
JOIN ${SCHEMA}.PRODUCTS p ON p.PRODUCT_ID = i.PRODUCT_ID
WHERE i.ORDER_ID = ?
ORDER BY i.LINE_NUMBER`

export async function loadOrder(orderId: string): Promise<SnowflakeOrder | null> {
  if (!/^\d{1,18}$/.test(orderId)) return null
  const [rows, lineRows] = await Promise.all([
    querySnowflake(ORDER_SQL, { binds: [orderId] }),
    querySnowflake(ORDER_LINES_SQL, { binds: [orderId] }),
  ])
  const o = rows[0]
  if (!o) return null
  return {
    orderId: Number(o.ORDER_ID),
    orderDate: String(o.ORDER_DATE),
    orderStatus: String(o.ORDER_STATUS),
    isTestOrder: Boolean(o.IS_TEST_ORDER),
    customerName: o.CUSTOMER_NAME ?? null,
    customerEmail: o.CUSTOMER_EMAIL ?? null,
    storeName: String(o.STORE_NAME ?? ""),
    shipping: Number(o.SHIPPING_USD ?? 0),
    lines: lineRows.map((l) => ({
      lineNumber: Number(l.LINE_NUMBER),
      sku: String(l.SKU),
      productName: String(l.PRODUCT_NAME),
      quantity: Number(l.QUANTITY),
      unitPrice: Number(l.UNIT_PRICE),
      discount: Number(l.DISCOUNT_AMOUNT),
      net: Number(l.NET),
    })),
  }
}

/** Lookups needed to validate a NEW invoice (product SKUs, customer email, store name). */
export async function loadReferences(inv: ExtractedInvoice): Promise<ReferenceLookups> {
  const skus = [...new Set(inv.lines.map((l) => normalizeSku(l.sku)).filter(Boolean))]
  const productRows = skus.length
    ? await querySnowflake(
        `SELECT SKU, PRODUCT_NAME, LIST_PRICE::FLOAT AS LIST_PRICE FROM ${SCHEMA}.PRODUCTS WHERE SKU IN (${skus.map(() => "?").join(",")})`,
        { binds: skus },
      )
    : []
  const [refRow] = await querySnowflake(
    `SELECT (SELECT COUNT(*) FROM ${SCHEMA}.CUSTOMERS WHERE EMAIL ILIKE ?) AS CUSTOMERS,
            (SELECT COUNT(*) FROM ${SCHEMA}.STORES WHERE STORE_NAME ILIKE ?) AS STORES`,
    { binds: [inv.customerEmail || "", inv.storeName || ""] },
  )
  const products: ReferenceLookups["products"] = {}
  for (const p of productRows) products[String(p.SKU)] = { productName: String(p.PRODUCT_NAME), listPrice: Number(p.LIST_PRICE) }
  return {
    products,
    customerExists: Number(refRow?.CUSTOMERS ?? 0) > 0,
    storeExists: Number(refRow?.STORES ?? 0) > 0,
  }
}

export interface Comparison {
  order: SnowflakeOrder | null
  references: ReferenceLookups | null
  result: ReconcileResult
}

export async function compareInvoice(inv: ExtractedInvoice): Promise<Comparison> {
  const order = await loadOrder(inv.orderId)
  const references = order ? null : await loadReferences(inv)
  const result = reconcile(inv, order, references ?? { products: {}, customerExists: false, storeExists: false })
  return { order, references, result }
}

export interface ApproveInput {
  invoice: ExtractedInvoice
  filePath: string
  fileName: string
  extracted: unknown
  editedFields: string[]
  approvedBy: string
}

/** Build the APPROVE_INVOICE payload from a freshly computed reconciliation. */
export function buildApprovePayload(input: ApproveInput, result: ReconcileResult) {
  const { invoice: inv } = input
  const statusByLine = new Map(result.lines.map((l) => [l.lineNumber, l.status]))
  return {
    invoice_number: inv.invoiceNumber,
    order_id: inv.orderId,
    invoice_date: inv.invoiceDate || null,
    order_date: inv.orderDate || null,
    customer_name: inv.customerName || null,
    customer_email: inv.customerEmail || null,
    store_name: inv.storeName || null,
    subtotal_usd: inv.subtotal,
    discount_usd: inv.discountTotal,
    shipping_usd: inv.shipping,
    total_usd: result.invoiceTotal,
    match_status: result.status,
    variance_usd: result.varianceUsd,
    file_name: input.fileName,
    file_path: input.filePath,
    extracted_json: input.extracted ?? null,
    edited_fields: input.editedFields,
    approved_by: input.approvedBy,
    lines: inv.lines.map((l) => ({
      line_number: l.lineNumber,
      sku: normalizeSku(l.sku),
      description: l.description,
      quantity: l.quantity,
      unit_price: l.unitPrice,
      discount_amount: l.discount ?? 0,
      line_amount: lineNet(l),
      line_status: statusByLine.get(l.lineNumber) ?? result.status,
    })),
    discrepancies: result.discrepancies.map((d) => ({
      scope: d.scope,
      line_number: d.lineNumber,
      field_name: d.field,
      invoice_value: d.invoiceValue,
      snowflake_value: d.snowflakeValue,
      difference_usd: d.differenceUsd,
    })),
  }
}

export interface ApproveResult {
  ok: boolean
  invoice_id?: string
  match_status?: string
  order_created?: boolean
  order_id?: number
  errors?: string[]
}

export async function approveInvoice(payload: ReturnType<typeof buildApprovePayload>): Promise<ApproveResult> {
  const rows = await querySnowflake(`CALL ${SCHEMA}.APPROVE_INVOICE(PARSE_JSON(?))`, {
    binds: [JSON.stringify(payload)],
  })
  const value = rows[0]?.APPROVE_INVOICE
  return (typeof value === "string" ? JSON.parse(value) : value) as ApproveResult
}

/** Requests arriving through Snowflake ingress carry the signed-in user's name. */
export function currentUser(headers: Headers): string {
  return headers.get("sf-context-current-user") || "local-dev"
}
