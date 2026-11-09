import { describe, expect, it } from "vitest"
import { isValidStagePath, normalizeExtraction, parseDate, parseMoney } from "../../lib/extract"

// Captured from AI_EXTRACT on test_invoices/mismatched/INV-2026-000198.pdf
const RAW = {
  error: null,
  response: {
    customer_email: "customer3096@example.com",
    customer_name: "Avery Clark",
    discount_total: "-$4.62",
    invoice_date: "2026-09-29",
    invoice_number: "INV-2026-000198",
    line_items: {
      amount: ["$472.50", "$41.58", "$65.55", "$61.25"],
      description: ["GRANITE CO Tents C", "NORTHPEAK Carabiners B", "RIVERRUN Harnesses A", "SUMMIT Bike Lights C"],
      discount: ["$0.00", "$4.62", "$0.00", "$0.00"],
      line: ["1", "2", "3", "4"],
      qty: ["2", "3", "1", "1"],
      sku: ["SKU-00081", "SKU-00098", "SKU-00115", "SKU-00150"],
      unit_price: ["$236.25", "$15.40", "$65.55", "$61.25"],
    },
    order_date: "2026-09-29",
    order_number: "198",
    shipping: "$14.00",
    store_name: "Summit Online",
    subtotal: "$645.50",
    total_due: "$654.88",
  },
  scoring: { scores: { line_items: { score: 0.98 }, discount_total: { score: 0.85 } } },
}

describe("parseMoney", () => {
  it.each([
    ["$1,013.56", 1013.56],
    ["-$4.62", -4.62],
    ["(4.62)", -4.62],
    ["12", 12],
    ["None", null],
    ["", null],
    [7.125, 7.13],
  ])("%s -> %s", (input, expected) => {
    expect(parseMoney(input)).toBe(expected)
  })
})

describe("parseDate", () => {
  it("normalises common formats", () => {
    expect(parseDate("2026-9-3")).toBe("2026-09-03")
    expect(parseDate("09/29/2026")).toBe("2026-09-29")
    expect(parseDate("None")).toBe("")
  })
})

describe("normalizeExtraction", () => {
  it("maps the AI_EXTRACT response to an ExtractedInvoice", () => {
    const { invoice, scores, error } = normalizeExtraction(RAW)
    expect(error).toBeNull()
    expect(invoice).toMatchObject({
      invoiceNumber: "INV-2026-000198",
      orderId: "198",
      orderDate: "2026-09-29",
      customerEmail: "customer3096@example.com",
      storeName: "Summit Online",
      subtotal: 645.5,
      discountTotal: 4.62, // printed negative, stored positive
      shipping: 14,
      total: 654.88,
    })
    expect(invoice.lines).toHaveLength(4)
    expect(invoice.lines[1]).toEqual({
      lineNumber: 2,
      sku: "SKU-00098",
      description: "NORTHPEAK Carabiners B",
      quantity: 3,
      unitPrice: 15.4,
      discount: 4.62,
      amount: 41.58,
    })
    expect(scores).toEqual({ line_items: 0.98, discount_total: 0.85 })
  })

  it("keeps a typo'd SKU as printed so the reviewer can fix it", () => {
    const raw = { response: { line_items: { sku: ["sku-0o112"], description: ["NORTHPEAK Harnesses A"], qty: ["1"] } } }
    expect(normalizeExtraction(raw).invoice.lines[0].sku).toBe("SKU-0O112")
  })

  it("drops blank padding rows and accepts a JSON string", () => {
    const raw = JSON.stringify({ response: { line_items: { sku: ["SKU-00001", ""], description: ["A", ""] } } })
    expect(normalizeExtraction(raw).invoice.lines).toHaveLength(1)
  })

  it("surfaces the model error", () => {
    expect(normalizeExtraction({ error: "Provided file cannot be found.", response: null }).error).toBe("Provided file cannot be found.")
  })
})

describe("isValidStagePath", () => {
  it("accepts only UPLOAD_INVOICE paths", () => {
    expect(isValidStagePath("0123456789abcdef0123456789abcdef/INV-2026-000198.pdf")).toBe(true)
    expect(isValidStagePath("../etc/passwd.pdf")).toBe(false)
    expect(isValidStagePath("0123456789abcdef0123456789abcdef/a b.pdf")).toBe(false)
    expect(isValidStagePath("x/'); DROP TABLE t; --.pdf")).toBe(false)
  })
})
