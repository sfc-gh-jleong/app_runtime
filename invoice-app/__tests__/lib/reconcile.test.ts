import { describe, expect, it } from "vitest"
import { hasBlockingIssues, reconcile } from "../../lib/reconcile"
import type { ExtractedInvoice, ReferenceLookups, SnowflakeOrder } from "../../lib/invoice-types"

const order: SnowflakeOrder = {
  orderId: 198,
  orderDate: "2026-09-29",
  orderStatus: "DELIVERED",
  isTestOrder: false,
  customerName: "Avery Clark",
  customerEmail: "customer3096@example.com",
  storeName: "Summit Online",
  shipping: 14,
  lines: [
    { lineNumber: 1, sku: "SKU-00081", productName: "GRANITE CO Tents C", quantity: 2, unitPrice: 236.25, discount: 0, net: 472.5 },
    { lineNumber: 2, sku: "SKU-00098", productName: "NORTHPEAK Carabiners B", quantity: 3, unitPrice: 15.4, discount: 4.62, net: 41.58 },
    { lineNumber: 3, sku: "SKU-00115", productName: "RIVERRUN Harnesses A", quantity: 1, unitPrice: 65.55, discount: 0, net: 65.55 },
  ],
}

function invoiceFrom(o: SnowflakeOrder): ExtractedInvoice {
  const lines = o.lines.map((l) => ({
    lineNumber: l.lineNumber,
    sku: l.sku,
    description: l.productName,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    discount: l.discount,
    amount: l.net,
  }))
  const net = lines.reduce((s, l) => s + l.amount, 0)
  return {
    invoiceNumber: `INV-2026-${String(o.orderId).padStart(6, "0")}`,
    orderId: String(o.orderId),
    invoiceDate: o.orderDate,
    orderDate: o.orderDate,
    customerName: o.customerName ?? "",
    customerEmail: o.customerEmail ?? "",
    storeName: o.storeName,
    subtotal: null,
    discountTotal: null,
    shipping: o.shipping,
    total: Math.round((net + o.shipping) * 100) / 100,
    lines,
  }
}

const noRefs: ReferenceLookups = { products: {}, customerExists: false, storeExists: false }

describe("reconcile against an existing order", () => {
  it("MATCHED when every value agrees", () => {
    const r = reconcile(invoiceFrom(order), order, noRefs)
    expect(r.status).toBe("MATCHED")
    expect(r.discrepancies).toEqual([])
    expect(r.varianceUsd).toBe(0)
    expect(r.lines.every((l) => l.status === "MATCHED")).toBe(true)
  })

  it("flags a quantity change with its dollar impact", () => {
    const inv = invoiceFrom(order)
    inv.lines[0] = { ...inv.lines[0], quantity: 3, amount: 708.75 }
    inv.total = 708.75 + 41.58 + 65.55 + 14
    const r = reconcile(inv, order, noRefs)
    expect(r.status).toBe("MISMATCHED")
    expect(r.lines[0]).toMatchObject({ status: "MISMATCHED", fields: ["quantity"] })
    expect(r.discrepancies.find((d) => d.field === "quantity")).toMatchObject({ invoiceValue: "3", snowflakeValue: "2", differenceUsd: 236.25 })
    expect(r.varianceUsd).toBe(236.25)
  })

  it("matches by SKU so a missing middle line does not cascade", () => {
    const inv = invoiceFrom(order)
    inv.lines.splice(1, 1)
    inv.total = 472.5 + 65.55 + 14
    const r = reconcile(inv, order, noRefs)
    expect(r.lines.map((l) => l.status)).toEqual(["MATCHED", "MATCHED"])
    expect(r.missingLines.map((l) => l.sku)).toEqual(["SKU-00098"])
    expect(r.discrepancies.find((d) => d.field === "missing_line")).toMatchObject({ snowflakeValue: "SKU-00098", differenceUsd: -41.58 })
  })

  it("flags an extra line", () => {
    const inv = invoiceFrom(order)
    inv.lines.push({ lineNumber: 4, sku: "SKU-00150", description: "SUMMIT Bike Lights C", quantity: 1, unitPrice: 61.25, discount: 0, amount: 61.25 })
    inv.total = (inv.total ?? 0) + 61.25
    const r = reconcile(inv, order, noRefs)
    expect(r.lines[3].status).toBe("EXTRA")
    expect(r.varianceUsd).toBe(61.25)
  })

  it("flags header differences (shipping, email) case-insensitively for text", () => {
    const inv = invoiceFrom(order)
    inv.customerEmail = "CUSTOMER3096@EXAMPLE.COM"
    expect(reconcile(inv, order, noRefs).status).toBe("MATCHED")
    inv.customerEmail = "customer4242@example.com"
    inv.shipping = 21.5
    inv.total = (inv.total ?? 0) + 7.5
    const r = reconcile(inv, order, noRefs)
    expect(r.headerMismatches).toEqual(expect.arrayContaining(["customerEmail", "shipping", "total"]))
    expect(r.discrepancies.find((d) => d.field === "shipping_usd")?.differenceUsd).toBe(7.5)
  })

  it("warns when the invoice arithmetic does not add up", () => {
    const inv = invoiceFrom(order)
    inv.lines[0] = { ...inv.lines[0], amount: 400 }
    const r = reconcile(inv, order, noRefs)
    expect(r.issues.some((i) => i.severity === "warning" && i.field === "lines.1.amount")).toBe(true)
  })
})

describe("reconcile a NEW invoice", () => {
  const refs: ReferenceLookups = {
    products: { "SKU-00163": { productName: "SUMMIT Helmets A", listPrice: 84.55 } },
    customerExists: true,
    storeExists: true,
  }
  const inv: ExtractedInvoice = {
    invoiceNumber: "INV-2026-060004",
    orderId: "60004",
    invoiceDate: "2026-11-07",
    orderDate: "2026-11-07",
    customerName: "Avery Lopez",
    customerEmail: "customer7781@example.com",
    storeName: "Summit Boulder",
    subtotal: 234.65,
    discountTotal: 0,
    shipping: 6,
    total: 240.65,
    lines: [
      { lineNumber: 1, sku: "SKU-0O112", description: "NORTHPEAK Harnesses A", quantity: 1, unitPrice: 65.55, discount: 0, amount: 65.55 },
      { lineNumber: 2, sku: "SKU-00163", description: "SUMMIT Helmets A", quantity: 2, unitPrice: 84.55, discount: 0, amount: 169.1 },
    ],
  }

  it("blocks approval on an unknown SKU", () => {
    const r = reconcile(inv, null, refs)
    expect(r.status).toBe("NEW")
    expect(hasBlockingIssues(r)).toBe(true)
    expect(r.issues.find((i) => i.field === "lines.1.sku")?.message).toContain("SKU-0O112")
  })

  it("is approvable once the SKU is corrected", () => {
    const fixed = { ...inv, lines: [{ ...inv.lines[0], sku: "SKU-00112" }, inv.lines[1]] }
    const r = reconcile(fixed, null, { ...refs, products: { ...refs.products, "SKU-00112": { productName: "NORTHPEAK Harnesses A", listPrice: 65.55 } } })
    expect(hasBlockingIssues(r)).toBe(false)
  })

  it("blocks on unknown customer or store", () => {
    const r = reconcile(inv, null, { ...refs, customerExists: false, storeExists: false })
    expect(r.issues.filter((i) => i.severity === "blocking").map((i) => i.field)).toEqual(
      expect.arrayContaining(["customerEmail", "storeName"]),
    )
  })
})
