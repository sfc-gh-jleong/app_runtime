"use client"

import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, Plus, Trash2, Undo2 } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { StatusBadge } from "@/components/invoices/status-badge"
import type { Comparison } from "@/components/invoices/invoice-workbench"
import type { ExtractedInvoice, ExtractionScores, InvoiceLine } from "@/lib/invoice-types"
import { formatCurrency } from "@/lib/format"
import { cn } from "@/lib/utils"

const LOW_CONFIDENCE = 0.9

/** ExtractedInvoice field -> AI_EXTRACT response key (for confidence scores). */
const SCORE_KEY: Partial<Record<keyof ExtractedInvoice, string>> = {
  invoiceNumber: "invoice_number",
  orderId: "order_number",
  invoiceDate: "invoice_date",
  orderDate: "order_date",
  customerName: "customer_name",
  customerEmail: "customer_email",
  storeName: "store_name",
  subtotal: "subtotal",
  discountTotal: "discount_total",
  shipping: "shipping",
  total: "total_due",
}

type HeaderField = Exclude<keyof ExtractedInvoice, "lines">

const HEADER_FIELDS: { key: HeaderField; label: string; type: "text" | "money" | "date" }[] = [
  { key: "invoiceNumber", label: "Invoice number", type: "text" },
  { key: "orderId", label: "Order number", type: "text" },
  { key: "invoiceDate", label: "Invoice date", type: "date" },
  { key: "orderDate", label: "Order date", type: "date" },
  { key: "customerName", label: "Customer name", type: "text" },
  { key: "customerEmail", label: "Customer email", type: "text" },
  { key: "storeName", label: "Store", type: "text" },
  { key: "subtotal", label: "Subtotal", type: "money" },
  { key: "discountTotal", label: "Discount", type: "money" },
  { key: "shipping", label: "Shipping", type: "money" },
  { key: "total", label: "Total due", type: "money" },
]

function toNumber(v: string): number | null {
  if (v.trim() === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function ReviewPanel({
  fileUrl,
  fileName,
  invoice,
  onChange,
  comparison,
  scores,
  editedFields,
  rechecking,
  approving,
  approveErrors,
  onApprove,
  onDiscard,
  onRevert,
}: {
  fileUrl: string | null
  fileName: string
  invoice: ExtractedInvoice
  onChange: (inv: ExtractedInvoice) => void
  comparison: Comparison
  scores: ExtractionScores
  editedFields: string[]
  rechecking: boolean
  approving: boolean
  approveErrors: string[]
  onApprove: () => void
  onDiscard: () => void
  onRevert: () => void
}) {
  const { order, result } = comparison
  const edited = new Set(editedFields)
  const blocking = result.issues.filter((i) => i.severity === "blocking")
  const warnings = result.issues.filter((i) => i.severity === "warning")
  const mismatched = new Set(result.headerMismatches)

  const snowflakeValue = (key: HeaderField): string | null => {
    if (!order) return null
    switch (key) {
      case "customerName": return order.customerName
      case "customerEmail": return order.customerEmail
      case "storeName": return order.storeName
      case "orderDate": return order.orderDate
      case "shipping": return formatCurrency(order.shipping)
      case "total": return result.expectedTotal === null ? null : formatCurrency(result.expectedTotal)
      default: return null
    }
  }

  const setField = (key: HeaderField, value: string, type: "text" | "money" | "date") =>
    onChange({ ...invoice, [key]: type === "money" ? toNumber(value) : value })

  const setLine = (index: number, patch: Partial<InvoiceLine>) =>
    onChange({ ...invoice, lines: invoice.lines.map((l, i) => (i === index ? { ...l, ...patch } : l)) })

  const addLine = () =>
    onChange({
      ...invoice,
      lines: [
        ...invoice.lines,
        { lineNumber: Math.max(0, ...invoice.lines.map((l) => l.lineNumber)) + 1, sku: "", description: "", quantity: 1, unitPrice: null, discount: 0, amount: null },
      ],
    })

  const removeLine = (index: number) => onChange({ ...invoice, lines: invoice.lines.filter((_, i) => i !== index) })

  const lineResult = (lineNumber: number) => result.lines.find((l) => l.lineNumber === lineNumber)

  return (
    <div className="grid gap-4 lg:grid-cols-5 animate-in fade-in slide-in-from-bottom-2 motion-reduce:animate-none">
      {/* PDF preview */}
      <Card className="min-w-0 lg:col-span-2">
        <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <div className="min-w-0">
            <CardTitle className="truncate">{fileName || "Invoice"}</CardTitle>
            <CardDescription>Original PDF</CardDescription>
          </div>
          {fileUrl && (
            <Button asChild variant="outline" size="sm">
              <a href={fileUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" /> Open
              </a>
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {fileUrl ? (
            <iframe src={fileUrl} title="Invoice PDF preview" className="h-[640px] w-full rounded-md border bg-muted" />
          ) : (
            <p className="text-sm text-muted-foreground">Preview unavailable.</p>
          )}
        </CardContent>
      </Card>

      <div className="min-w-0 space-y-4 lg:col-span-3">
        {/* Verdict */}
        <Card>
          <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 p-5">
            <div className="flex items-center gap-2">
              <StatusBadge status={result.status} />
              {rechecking && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Re-checking" />}
            </div>
            <p className="min-w-0 flex-1 text-sm text-muted-foreground">
              {result.status === "NEW"
                ? `Order ${invoice.orderId || "?"} does not exist. Approving creates it in ORDERS and ORDER_ITEMS.`
                : result.status === "MATCHED"
                  ? `Invoice agrees with order ${order?.orderId} in Snowflake.`
                  : `${result.discrepancies.length} difference${result.discrepancies.length === 1 ? "" : "s"} from order ${order?.orderId}.`}
            </p>
            {result.status !== "NEW" && (
              <div className="text-right text-sm">
                <p className="tabular-nums">
                  Invoice {formatCurrency(result.invoiceTotal)} · Snowflake {formatCurrency(result.expectedTotal)}
                </p>
                {result.varianceUsd !== null && Math.abs(result.varianceUsd) >= 0.005 && (
                  <p className={cn("font-medium tabular-nums", result.varianceUsd > 0 ? "text-destructive" : "text-warning")}>
                    Variance {result.varianceUsd > 0 ? "+" : ""}
                    {formatCurrency(result.varianceUsd)}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {(blocking.length > 0 || approveErrors.length > 0) && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Fix before approving</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-0.5 pl-4">
                {[...new Set([...blocking.map((b) => b.message), ...approveErrors])].map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {warnings.length > 0 && (
          <Alert>
            <AlertTriangle className="h-4 w-4 text-warning" />
            <AlertTitle>Check</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-0.5 pl-4">
                {warnings.map((w) => (
                  <li key={w.field + w.message}>{w.message}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {/* Header fields */}
        <Card>
          <CardHeader>
            <CardTitle>Invoice details</CardTitle>
            <CardDescription>Extracted values. Edit anything that is wrong; the comparison re-runs as you type.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {HEADER_FIELDS.map((f) => {
              const score = SCORE_KEY[f.key] ? scores[SCORE_KEY[f.key]!] : undefined
              const value = invoice[f.key]
              const sf = snowflakeValue(f.key)
              const isMismatch = mismatched.has(f.key)
              const blockingField = blocking.some((b) => b.field === f.key)
              return (
                <div key={f.key} className="min-w-0 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Label htmlFor={`f-${f.key}`}>{f.label}</Label>
                    {edited.has(f.key) && <Badge variant="secondary">Edited</Badge>}
                    {score !== undefined && score < LOW_CONFIDENCE && (
                      <span className="text-xs text-warning" title="AI_EXTRACT confidence">
                        {Math.round(score * 100)}% confidence
                      </span>
                    )}
                  </div>
                  <Input
                    id={`f-${f.key}`}
                    type={f.type === "money" ? "number" : f.type === "date" ? "date" : "text"}
                    step={f.type === "money" ? "0.01" : undefined}
                    value={value === null || value === undefined ? "" : String(value)}
                    onChange={(e) => setField(f.key, e.target.value, f.type)}
                    className={cn((isMismatch || blockingField) && "border-warning focus-visible:ring-warning")}
                  />
                  {order && sf !== null && (
                    <p className={cn("flex items-center gap-1 truncate text-xs", isMismatch ? "text-warning" : "text-muted-foreground")}>
                      {isMismatch ? <AlertTriangle className="h-3 w-3 shrink-0" /> : <CheckCircle2 className="h-3 w-3 shrink-0 text-success" />}
                      Snowflake: {sf || "(blank)"}
                    </p>
                  )}
                </div>
              )
            })}
          </CardContent>
        </Card>

        {/* Lines */}
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle>Line items</CardTitle>
              <CardDescription>
                Matched to order lines by SKU
                {scores.line_items !== undefined && ` · ${Math.round(scores.line_items * 100)}% extraction confidence`}
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={addLine}>
              <Plus className="h-4 w-4" /> Add line
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">#</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead numeric>Qty</TableHead>
                  <TableHead numeric>Unit price</TableHead>
                  <TableHead numeric>Discount</TableHead>
                  <TableHead numeric>Amount</TableHead>
                  <TableHead className="w-24">Status</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoice.lines.map((l, i) => {
                  const lr = lineResult(l.lineNumber)
                  const bad = new Set(lr?.fields ?? [])
                  const sf = lr?.snowflake
                  const cellCls = (field: string) => cn("no-spin h-8 px-2", bad.has(field) && "border-warning")
                  return (
                    <TableRow key={i} className="align-top">
                      <TableCell className="pt-3 tabular-nums">{l.lineNumber}</TableCell>
                      <TableCell>
                        <Input aria-label={`Line ${l.lineNumber} SKU`} value={l.sku} onChange={(e) => setLine(i, { sku: e.target.value.toUpperCase() })} className={cn(cellCls("sku"), "w-32 font-mono text-xs")} />
                      </TableCell>
                      <TableCell>
                        <Input aria-label={`Line ${l.lineNumber} description`} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} className="h-8 min-w-44 px-2" />
                      </TableCell>
                      <TableCell numeric>
                        <Input aria-label={`Line ${l.lineNumber} quantity`} type="number" value={l.quantity ?? ""} onChange={(e) => setLine(i, { quantity: toNumber(e.target.value) })} className={cn(cellCls("quantity"), "w-16 text-right")} />
                        {sf && bad.has("quantity") && <p className="mt-1 text-xs text-warning">SF {sf.quantity}</p>}
                      </TableCell>
                      <TableCell numeric>
                        <Input aria-label={`Line ${l.lineNumber} unit price`} type="number" step="0.01" value={l.unitPrice ?? ""} onChange={(e) => setLine(i, { unitPrice: toNumber(e.target.value) })} className={cn(cellCls("unitPrice"), "w-24 text-right")} />
                        {sf && bad.has("unitPrice") && <p className="mt-1 text-xs text-warning">SF {sf.unitPrice.toFixed(2)}</p>}
                      </TableCell>
                      <TableCell numeric>
                        <Input aria-label={`Line ${l.lineNumber} discount`} type="number" step="0.01" value={l.discount ?? ""} onChange={(e) => setLine(i, { discount: toNumber(e.target.value) })} className={cn(cellCls("discount"), "w-20 text-right")} />
                        {sf && bad.has("discount") && <p className="mt-1 text-xs text-warning">SF {sf.discount.toFixed(2)}</p>}
                      </TableCell>
                      <TableCell numeric>
                        <Input aria-label={`Line ${l.lineNumber} amount`} type="number" step="0.01" value={l.amount ?? ""} onChange={(e) => setLine(i, { amount: toNumber(e.target.value) })} className="no-spin h-8 w-24 px-2 text-right" />
                      </TableCell>
                      <TableCell className="pt-3">
                        <StatusBadge status={lr?.status ?? result.status} />
                      </TableCell>
                      <TableCell className="pt-2">
                        <Button variant="ghost" size="icon" aria-label={`Remove line ${l.lineNumber}`} onClick={() => removeLine(i)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
                {result.missingLines.map((m) => (
                  <TableRow key={`missing-${m.lineNumber}`} className="bg-destructive/5">
                    <TableCell className="tabular-nums">{m.lineNumber}</TableCell>
                    <TableCell className="font-mono text-xs">{m.sku}</TableCell>
                    <TableCell className="truncate text-muted-foreground">{m.productName}</TableCell>
                    <TableCell numeric>{m.quantity}</TableCell>
                    <TableCell numeric>{m.unitPrice.toFixed(2)}</TableCell>
                    <TableCell numeric>{m.discount.toFixed(2)}</TableCell>
                    <TableCell numeric>{m.net.toFixed(2)}</TableCell>
                    <TableCell>
                      <StatusBadge status="MISSING" />
                    </TableCell>
                    <TableCell />
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Discrepancy summary */}
        {result.discrepancies.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Differences from Snowflake</CardTitle>
              <CardDescription>These are stored in INVOICE_DISCREPANCIES on approval.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table striped>
                <TableHeader>
                  <TableRow>
                    <TableHead>Field</TableHead>
                    <TableHead>Line</TableHead>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Snowflake</TableHead>
                    <TableHead numeric>Impact</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.discrepancies.map((d, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-xs">{d.field}</TableCell>
                      <TableCell className="tabular-nums">{d.lineNumber ?? "—"}</TableCell>
                      <TableCell className="truncate">{d.invoiceValue ?? "—"}</TableCell>
                      <TableCell className="truncate">{d.snowflakeValue ?? "—"}</TableCell>
                      <TableCell numeric>{d.differenceUsd === null ? "—" : formatCurrency(d.differenceUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {editedFields.length > 0 && (
            <Button variant="ghost" onClick={onRevert} disabled={approving}>
              <Undo2 className="h-4 w-4" /> Revert {editedFields.length} edit{editedFields.length === 1 ? "" : "s"}
            </Button>
          )}
          <Button variant="outline" onClick={onDiscard} disabled={approving}>
            Discard
          </Button>
          <Button onClick={onApprove} disabled={approving || rechecking || blocking.length > 0}>
            {approving && <Loader2 className="h-4 w-4 animate-spin" />}
            {result.status === "NEW" ? "Approve & create order" : "Approve & store"}
          </Button>
        </div>
      </div>
    </div>
  )
}
