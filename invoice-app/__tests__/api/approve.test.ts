import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "sf-context-current-user": "JLEONG" }),
}))
vi.mock("../../lib/snowflake", () => ({ querySnowflake: vi.fn() }))

import { querySnowflake } from "../../lib/snowflake"
import { POST } from "../../app/api/invoices/approve/route"

const FILE_PATH = "0123456789abcdef0123456789abcdef/INV-2026-060001.pdf"

const newInvoice = {
  invoiceNumber: "INV-2026-060001",
  orderId: "60001",
  invoiceDate: "2026-11-04",
  orderDate: "2026-11-04",
  customerName: "Test Customer",
  customerEmail: "customer1207@example.com",
  storeName: "Summit Online",
  subtotal: 100,
  discountTotal: 0,
  shipping: 9,
  total: 109,
  lines: [{ lineNumber: 1, sku: "SKU-00012", description: "Tent", quantity: 1, unitPrice: 100, discount: 0, amount: 100 }],
}

function request(body: unknown) {
  return new Request("http://localhost/api/invoices/approve", { method: "POST", body: JSON.stringify(body) })
}

/** Route query text -> mocked rows, so call order does not matter. */
function mockSnowflake(handlers: { order?: unknown[]; products?: unknown[]; refs?: unknown[]; approve?: unknown }) {
  vi.mocked(querySnowflake).mockImplementation(async (sql: string) => {
    if (sql.includes("APPROVE_INVOICE")) return [{ APPROVE_INVOICE: JSON.stringify(handlers.approve) }]
    if (sql.includes("FROM SNOWFLAKE_DEMO.CORTEX_SENSE.ORDER_ITEMS")) return []
    if (sql.includes("FROM SNOWFLAKE_DEMO.CORTEX_SENSE.ORDERS")) return (handlers.order ?? []) as Record<string, any>[]
    if (sql.includes("FROM SNOWFLAKE_DEMO.CORTEX_SENSE.PRODUCTS")) return (handlers.products ?? []) as Record<string, any>[]
    if (sql.includes("CUSTOMERS")) return (handlers.refs ?? [{ CUSTOMERS: 1, STORES: 1 }]) as Record<string, any>[]
    throw new Error(`unexpected SQL: ${sql}`)
  })
}

describe("POST /api/invoices/approve", () => {
  beforeEach(() => vi.clearAllMocks())

  it("rejects a malformed stage path before touching Snowflake", async () => {
    const res = await POST(request({ invoice: newInvoice, filePath: "../x.pdf" }))
    expect(res.status).toBe(400)
    expect(querySnowflake).not.toHaveBeenCalled()
  })

  it("re-validates server-side and refuses a NEW invoice with an unknown SKU", async () => {
    mockSnowflake({ products: [] })
    const res = await POST(request({ invoice: newInvoice, filePath: FILE_PATH }))
    const json = await res.json()
    expect(res.status).toBe(422)
    expect(json.errors.join(" ")).toContain("unknown SKU SKU-00012")
    expect(vi.mocked(querySnowflake).mock.calls.some(([sql]) => sql.includes("APPROVE_INVOICE"))).toBe(false)
  })

  it("approves a valid NEW invoice and passes the approver and computed status to the procedure", async () => {
    mockSnowflake({
      products: [{ SKU: "SKU-00012", PRODUCT_NAME: "Tent", LIST_PRICE: 100 }],
      approve: { ok: true, invoice_id: "abc", match_status: "NEW", order_created: true, order_id: 60001 },
    })
    const res = await POST(request({ invoice: newInvoice, filePath: FILE_PATH, fileName: "INV-2026-060001.pdf", editedFields: ["shipping"] }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ ok: true, order_created: true })

    const call = vi.mocked(querySnowflake).mock.calls.find(([sql]) => sql.includes("APPROVE_INVOICE"))!
    const payload = JSON.parse((call[1] as { binds: string[] }).binds[0])
    expect(payload).toMatchObject({
      invoice_number: "INV-2026-060001",
      match_status: "NEW",
      approved_by: "JLEONG",
      edited_fields: ["shipping"],
      file_path: FILE_PATH,
    })
    expect(payload.lines[0]).toMatchObject({ sku: "SKU-00012", line_amount: 100, line_status: "NEW" })
  })

  it("surfaces procedure errors as 422", async () => {
    mockSnowflake({
      products: [{ SKU: "SKU-00012", PRODUCT_NAME: "Tent", LIST_PRICE: 100 }],
      approve: { ok: false, errors: ["invoice_number: INV-2026-060001 has already been approved"] },
    })
    const res = await POST(request({ invoice: newInvoice, filePath: FILE_PATH }))
    expect(res.status).toBe(422)
    expect((await res.json()).errors[0]).toContain("already been approved")
  })
})
