/** Shared invoice types used by API routes and client components. */

export type MatchStatus = "MATCHED" | "MISMATCHED" | "NEW"
export type LineStatus = "MATCHED" | "MISMATCHED" | "EXTRA" | "MISSING" | "NEW"

export interface InvoiceLine {
  lineNumber: number
  sku: string
  description: string
  quantity: number | null
  unitPrice: number | null
  discount: number | null
  amount: number | null
}

/** An invoice as extracted from the PDF (and possibly edited by the reviewer). */
export interface ExtractedInvoice {
  invoiceNumber: string
  orderId: string
  invoiceDate: string
  orderDate: string
  customerName: string
  customerEmail: string
  storeName: string
  subtotal: number | null
  discountTotal: number | null
  shipping: number | null
  total: number | null
  lines: InvoiceLine[]
}

/** AI_EXTRACT confidence per field (0..1). Lines share one table-level score. */
export type ExtractionScores = Record<string, number>

export interface SnowflakeOrderLine {
  lineNumber: number
  sku: string
  productName: string
  quantity: number
  unitPrice: number
  discount: number
  net: number
}

export interface SnowflakeOrder {
  orderId: number
  orderDate: string
  orderStatus: string
  isTestOrder: boolean
  customerName: string | null
  customerEmail: string | null
  storeName: string
  shipping: number
  lines: SnowflakeOrderLine[]
}

/** Reference lookups used to validate a NEW invoice before it creates an order. */
export interface ReferenceLookups {
  /** SKU (upper-cased) -> product */
  products: Record<string, { productName: string; listPrice: number }>
  customerExists: boolean
  storeExists: boolean
}

export interface Discrepancy {
  scope: "HEADER" | "LINE"
  lineNumber: number | null
  field: string
  invoiceValue: string | null
  snowflakeValue: string | null
  differenceUsd: number | null
}

export interface Issue {
  /** Blocking issues prevent approval (NEW invoices that cannot create an order). */
  severity: "blocking" | "warning"
  field: string
  message: string
}

export interface LineResult {
  lineNumber: number
  sku: string
  status: LineStatus
  /** Snowflake values for the matched order line, if any. */
  snowflake: SnowflakeOrderLine | null
  /** Fields on this line that differ from Snowflake. */
  fields: string[]
}

export interface ReconcileResult {
  status: MatchStatus
  discrepancies: Discrepancy[]
  issues: Issue[]
  lines: LineResult[]
  /** Order lines in Snowflake that are not on the invoice. */
  missingLines: SnowflakeOrderLine[]
  /** Header fields that differ, keyed by ExtractedInvoice field name. */
  headerMismatches: string[]
  invoiceTotal: number | null
  expectedTotal: number | null
  varianceUsd: number | null
}
