"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/empty-state"
import { StatusBadge } from "@/components/invoices/status-badge"
import { formatCurrency, formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"

interface InvoiceRow {
  INVOICE_ID: string
  INVOICE_NUMBER: string
  ORDER_ID: number
  INVOICE_DATE: string | null
  CUSTOMER_NAME: string | null
  CUSTOMER_EMAIL: string | null
  STORE_NAME: string | null
  TOTAL_USD: number | null
  MATCH_STATUS: string
  DISCREPANCY_COUNT: number
  VARIANCE_USD: number | null
  ORDER_CREATED: boolean
  FILE_NAME: string | null
  APPROVED_BY: string | null
  APPROVED_AT: string
  EDITED_COUNT: number
}

interface InvoiceDetail {
  lines: { LINE_NUMBER: number; SKU: string; DESCRIPTION: string; QUANTITY: number; UNIT_PRICE: number; DISCOUNT_AMOUNT: number; LINE_AMOUNT: number; LINE_STATUS: string }[]
  discrepancies: { SCOPE: string; LINE_NUMBER: number | null; FIELD_NAME: string; INVOICE_VALUE: string | null; SNOWFLAKE_VALUE: string | null; DIFFERENCE_USD: number | null }[]
  editedFields: string[]
}

const FILTERS = ["ALL", "MATCHED", "MISMATCHED", "NEW"] as const

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url)
  const json = await r.json()
  if (!r.ok) throw new Error(json.error ?? "Request failed")
  return json
}

export function InvoiceHistory() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("ALL")
  const [selected, setSelected] = useState<InvoiceRow | null>(null)
  const { data, error, isPending } = useQuery({
    queryKey: ["invoices", filter],
    queryFn: () => getJson<InvoiceRow[]>(`/api/invoices${filter === "ALL" ? "" : `?status=${filter}`}`),
  })

  return (
    <Card>
      <CardHeader className="flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>Approved invoices</CardTitle>
          <CardDescription>SNOWFLAKE_DEMO.CORTEX_SENSE.INVOICES, newest first</CardDescription>
        </div>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <Button key={f} size="sm" variant={f === filter ? "default" : "outline"} onClick={() => setFilter(f)}>
              {f === "ALL" ? "All" : f.charAt(0) + f.slice(1).toLowerCase()}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {isPending ? (
          <div className="space-y-2 p-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : error ? (
          <div className="p-6">
            <EmptyState variant="error" title="Could not load invoices" description={error.message} />
          </div>
        ) : data.length === 0 ? (
          <div className="p-6">
            <EmptyState title="No invoices yet" description="Approved invoices appear here." />
          </div>
        ) : (
          <Table striped>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead numeric>Order</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Store</TableHead>
                <TableHead numeric>Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead numeric>Variance</TableHead>
                <TableHead>Approved</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((r) => (
                <TableRow key={r.INVOICE_ID} className="cursor-pointer" onClick={() => setSelected(r)}>
                  <TableCell className="font-medium">{r.INVOICE_NUMBER}</TableCell>
                  <TableCell numeric>{r.ORDER_ID}</TableCell>
                  <TableCell className="max-w-48 truncate">{r.CUSTOMER_NAME ?? "—"}</TableCell>
                  <TableCell className="max-w-40 truncate">{r.STORE_NAME ?? "—"}</TableCell>
                  <TableCell numeric>{formatCurrency(r.TOTAL_USD)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <StatusBadge status={r.MATCH_STATUS} />
                      {r.EDITED_COUNT > 0 && <Badge variant="secondary">Edited</Badge>}
                    </div>
                  </TableCell>
                  <TableCell numeric className={cn(r.VARIANCE_USD && r.VARIANCE_USD !== 0 && "text-warning")}>
                    {r.VARIANCE_USD === null ? "—" : formatCurrency(r.VARIANCE_USD)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(r.APPROVED_AT)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <InvoiceDetailSheet row={selected} onClose={() => setSelected(null)} />
    </Card>
  )
}

function InvoiceDetailSheet({ row, onClose }: { row: InvoiceRow | null; onClose: () => void }) {
  const { data, error, isPending } = useQuery({
    queryKey: ["invoice", row?.INVOICE_ID],
    queryFn: () => getJson<InvoiceDetail>(`/api/invoices/${row!.INVOICE_ID}`),
    enabled: !!row,
  })
  return (
    <Sheet open={!!row} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        {row && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                {row.INVOICE_NUMBER} <StatusBadge status={row.MATCH_STATUS} />
              </SheetTitle>
              <SheetDescription>
                Order {row.ORDER_ID}
                {row.ORDER_CREATED && " (created from this invoice)"} · {row.CUSTOMER_NAME} · {row.STORE_NAME} · approved by{" "}
                {row.APPROVED_BY ?? "—"} {formatDateTime(row.APPROVED_AT)}
              </SheetDescription>
            </SheetHeader>
            <div className="mt-6 space-y-6">
              {isPending ? (
                <Skeleton className="h-40 w-full" />
              ) : error ? (
                <EmptyState variant="error" title="Could not load invoice" description={error.message} />
              ) : (
                <>
                  <section className="space-y-2">
                    <h3 className="text-sm font-semibold">Lines</h3>
                    <Table bordered>
                      <TableHeader>
                        <TableRow>
                          <TableHead>#</TableHead>
                          <TableHead>SKU</TableHead>
                          <TableHead numeric>Qty</TableHead>
                          <TableHead numeric>Unit</TableHead>
                          <TableHead numeric>Amount</TableHead>
                          <TableHead>Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.lines.map((l) => (
                          <TableRow key={l.LINE_NUMBER}>
                            <TableCell>{l.LINE_NUMBER}</TableCell>
                            <TableCell>
                              <span className="font-mono text-xs">{l.SKU}</span>
                              <p className="truncate text-xs text-muted-foreground">{l.DESCRIPTION}</p>
                            </TableCell>
                            <TableCell numeric>{l.QUANTITY}</TableCell>
                            <TableCell numeric>{formatCurrency(l.UNIT_PRICE)}</TableCell>
                            <TableCell numeric>{formatCurrency(l.LINE_AMOUNT)}</TableCell>
                            <TableCell>
                              <StatusBadge status={l.LINE_STATUS} />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </section>
                  <section className="space-y-2">
                    <h3 className="text-sm font-semibold">Discrepancies</h3>
                    {data.discrepancies.length === 0 ? (
                      <p className="text-sm text-muted-foreground">None.</p>
                    ) : (
                      <Table bordered>
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
                          {data.discrepancies.map((d, i) => (
                            <TableRow key={i}>
                              <TableCell className="font-mono text-xs">{d.FIELD_NAME}</TableCell>
                              <TableCell>{d.LINE_NUMBER ?? "—"}</TableCell>
                              <TableCell className="truncate">{d.INVOICE_VALUE ?? "—"}</TableCell>
                              <TableCell className="truncate">{d.SNOWFLAKE_VALUE ?? "—"}</TableCell>
                              <TableCell numeric>{d.DIFFERENCE_USD === null ? "—" : formatCurrency(d.DIFFERENCE_USD)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </section>
                  {data.editedFields.length > 0 && (
                    <section className="space-y-2">
                      <h3 className="text-sm font-semibold">Edited before approval</h3>
                      <div className="flex flex-wrap gap-1">
                        {data.editedFields.map((f) => (
                          <Badge key={f} variant="secondary" className="font-mono">
                            {f}
                          </Badge>
                        ))}
                      </div>
                    </section>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
