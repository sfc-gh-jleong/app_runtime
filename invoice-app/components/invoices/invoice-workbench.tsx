"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, FileUp, Loader2, RotateCcw, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { ReviewPanel } from "@/components/invoices/review-panel"
import { StatusBadge } from "@/components/invoices/status-badge"
import type { ExtractedInvoice, ExtractionScores, ReconcileResult, SnowflakeOrder } from "@/lib/invoice-types"
import { cn } from "@/lib/utils"

type Stage = "idle" | "uploading" | "extracting" | "comparing" | "review" | "approving" | "done"

export interface Comparison {
  order: SnowflakeOrder | null
  result: ReconcileResult
}

interface Approved {
  invoiceId: string
  status: string
  orderCreated: boolean
  orderId: number
}

const STEPS: { stage: Stage; label: string }[] = [
  { stage: "uploading", label: "Upload to stage" },
  { stage: "extracting", label: "AI_EXTRACT" },
  { stage: "comparing", label: "Compare with Snowflake" },
  { stage: "review", label: "Review & approve" },
]

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const json = await r.json().catch(() => ({}))
  if (!r.ok) {
    const err = new Error(json.error ?? (json.errors as string[] | undefined)?.join("; ") ?? `Request failed (${r.status})`)
    ;(err as Error & { details?: unknown }).details = json
    throw err
  }
  return json as T
}

/** Field paths (e.g. "shipping", "lines.2.sku") whose value differs from the extraction. */
export function diffFields(original: ExtractedInvoice, current: ExtractedInvoice): string[] {
  const out: string[] = []
  for (const k of Object.keys(original) as (keyof ExtractedInvoice)[]) {
    if (k === "lines") continue
    if (original[k] !== current[k]) out.push(k)
  }
  const n = Math.max(original.lines.length, current.lines.length)
  for (let i = 0; i < n; i++) {
    const a = original.lines[i]
    const b = current.lines[i]
    if (!a || !b) {
      out.push(`lines.${i + 1}`)
      continue
    }
    for (const k of Object.keys(a) as (keyof typeof a)[]) if (a[k] !== b[k]) out.push(`lines.${i + 1}.${k}`)
  }
  return out
}

export function InvoiceWorkbench() {
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [stage, setStage] = useState<Stage>("idle")
  const [error, setError] = useState<string | null>(null)
  const [approveErrors, setApproveErrors] = useState<string[]>([])
  const [dragging, setDragging] = useState(false)

  const [fileUrl, setFileUrl] = useState<string | null>(null)
  const [file, setFile] = useState<{ path: string; name: string } | null>(null)
  const [raw, setRaw] = useState<unknown>(null)
  const [scores, setScores] = useState<ExtractionScores>({})
  const [original, setOriginal] = useState<ExtractedInvoice | null>(null)
  const [invoice, setInvoice] = useState<ExtractedInvoice | null>(null)
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [rechecking, setRechecking] = useState(false)
  const [approved, setApproved] = useState<Approved | null>(null)

  useEffect(() => () => { if (fileUrl) URL.revokeObjectURL(fileUrl) }, [fileUrl])

  const reset = useCallback(() => {
    setStage("idle")
    setError(null)
    setApproveErrors([])
    setFile(null)
    setRaw(null)
    setScores({})
    setOriginal(null)
    setInvoice(null)
    setComparison(null)
    setApproved(null)
    setFileUrl((u) => {
      if (u) URL.revokeObjectURL(u)
      return null
    })
    if (inputRef.current) inputRef.current.value = ""
  }, [])

  const process = useCallback(async (picked: File) => {
    reset()
    if (!picked.name.toLowerCase().endsWith(".pdf") && picked.type !== "application/pdf") {
      setError("Choose a PDF file")
      return
    }
    setFileUrl(URL.createObjectURL(picked))
    try {
      setStage("uploading")
      const form = new FormData()
      form.append("file", picked)
      const up = await fetch("/api/invoices/upload", { method: "POST", body: form })
      const upJson = await up.json()
      if (!up.ok) throw new Error(upJson.error ?? "Upload failed")
      setFile({ path: upJson.filePath, name: upJson.fileName })

      setStage("extracting")
      const ex = await postJson<{ invoice: ExtractedInvoice; scores: ExtractionScores; raw: unknown }>(
        "/api/invoices/extract",
        { filePath: upJson.filePath },
      )
      setRaw(ex.raw)
      setScores(ex.scores)
      setOriginal(ex.invoice)
      setInvoice(ex.invoice)

      setStage("comparing")
      setComparison(await postJson<Comparison>("/api/invoices/compare", { invoice: ex.invoice }))
      setStage("review")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Processing failed")
      setStage("idle")
    }
  }, [reset])

  // Live re-check while the reviewer edits (debounced).
  const firstCompare = useRef(true)
  useEffect(() => {
    if (stage !== "review" || !invoice) return
    if (firstCompare.current) {
      firstCompare.current = false
      return
    }
    const ctl = { cancelled: false }
    const t = setTimeout(async () => {
      setRechecking(true)
      try {
        const c = await postJson<Comparison>("/api/invoices/compare", { invoice })
        if (!ctl.cancelled) setComparison(c)
      } catch (e) {
        if (!ctl.cancelled) setError(e instanceof Error ? e.message : "Comparison failed")
      } finally {
        if (!ctl.cancelled) setRechecking(false)
      }
    }, 500)
    return () => {
      ctl.cancelled = true
      clearTimeout(t)
    }
  }, [invoice, stage])
  useEffect(() => {
    if (stage === "idle") firstCompare.current = true
  }, [stage])

  const editedFields = useMemo(() => (original && invoice ? diffFields(original, invoice) : []), [original, invoice])

  const approve = useCallback(async () => {
    if (!invoice || !file) return
    setStage("approving")
    setApproveErrors([])
    try {
      const res = await postJson<{ invoice_id: string; match_status: string; order_created: boolean; order_id: number }>(
        "/api/invoices/approve",
        { invoice, filePath: file.path, fileName: file.name, extracted: raw, editedFields },
      )
      setApproved({ invoiceId: res.invoice_id, status: res.match_status, orderCreated: res.order_created, orderId: res.order_id })
      setStage("done")
      queryClient.invalidateQueries({ queryKey: ["stats"] })
      queryClient.invalidateQueries({ queryKey: ["invoices"] })
    } catch (e) {
      const details = (e as Error & { details?: { errors?: string[]; result?: ReconcileResult } }).details
      setApproveErrors(details?.errors ?? [e instanceof Error ? e.message : "Approval failed"])
      if (details?.result && comparison) setComparison({ ...comparison, result: details.result })
      setStage("review")
    }
  }, [invoice, file, raw, editedFields, queryClient, comparison])

  const busy = stage === "uploading" || stage === "extracting" || stage === "comparing"
  const stepIndex = STEPS.findIndex((s) => s.stage === stage)

  if (stage === "done" && approved) {
    return (
      <Card className="animate-in fade-in slide-in-from-bottom-2 motion-reduce:animate-none">
        <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-success/15 text-success">
            <CheckCircle2 className="h-6 w-6" />
          </span>
          <div className="space-y-1">
            <p className="text-lg font-semibold">Invoice {invoice?.invoiceNumber} approved</p>
            <p className="text-sm text-muted-foreground">
              Stored in INVOICES as <StatusBadge status={approved.status} />
              {approved.orderCreated && <> and created order {approved.orderId} in ORDERS / ORDER_ITEMS</>}.
            </p>
          </div>
          <Button onClick={reset}>
            <FileUp className="h-4 w-4" /> Process another invoice
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {stage === "idle" || busy ? (
        <Card>
          <CardHeader>
            <CardTitle>Upload an invoice</CardTitle>
            <CardDescription>
              PDF up to 10 MB. The file is stored on @INVOICE_STAGE, read with AI_EXTRACT and compared with ORDERS and
              ORDER_ITEMS before anything is written.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <label
              onDragOver={(e) => {
                e.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragging(false)
                const f = e.dataTransfer.files?.[0]
                if (f && !busy) void process(f)
              }}
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-6 py-12 text-center transition-colors",
                dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/60",
                busy && "pointer-events-none opacity-70",
              )}
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
                {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}
              </span>
              <span className="text-sm font-medium">{busy ? "Processing…" : "Drop a PDF here or click to choose"}</span>
              <input
                ref={inputRef}
                type="file"
                accept="application/pdf,.pdf"
                className="sr-only"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void process(f)
                }}
              />
            </label>
            {busy && (
              <ol className="grid gap-2 sm:grid-cols-4">
                {STEPS.map((s, i) => (
                  <li
                    key={s.stage}
                    className={cn(
                      "flex items-center gap-2 rounded-md border px-3 py-2 text-xs",
                      i < stepIndex && "border-success/40 text-success",
                      i === stepIndex && "border-primary text-primary",
                      i > stepIndex && "text-muted-foreground",
                    )}
                  >
                    {i === stepIndex ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <span className="tabular-nums">{i + 1}.</span>}
                    {s.label}
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      ) : null}

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}

      {(stage === "review" || stage === "approving") && invoice && comparison && (
        <ReviewPanel
          fileUrl={fileUrl}
          fileName={file?.name ?? ""}
          invoice={invoice}
          onChange={setInvoice}
          comparison={comparison}
          scores={scores}
          editedFields={editedFields}
          rechecking={rechecking}
          approving={stage === "approving"}
          approveErrors={approveErrors}
          onApprove={approve}
          onDiscard={reset}
          onRevert={() => original && setInvoice(original)}
        />
      )}

      {stage === "review" && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={reset}>
            <RotateCcw className="h-4 w-4" /> Start over
          </Button>
        </div>
      )}
    </div>
  )
}
