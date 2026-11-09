"use client"

import { useQuery } from "@tanstack/react-query"
import { CheckCircle2, FilePlus2, FileWarning, Receipt } from "lucide-react"
import { EmptyState } from "@/components/empty-state"
import { StatCard, StatCardSkeleton } from "@/components/stat-card"
import { formatCurrency, formatNumber, formatPercent } from "@/lib/format"

interface Stats {
  total: number
  matched: number
  mismatched: number
  new: number
  invoicedUsd: number
  absVarianceUsd: number
  ordersCreated: number
}

async function fetchStats(): Promise<Stats> {
  const r = await fetch("/api/stats")
  const json = await r.json()
  if (!r.ok) throw new Error(json.error ?? "Failed to load stats")
  return json
}

export function StatsRow() {
  const { data, error, isPending } = useQuery({ queryKey: ["stats"], queryFn: fetchStats })

  if (isPending) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <StatCardSkeleton key={i} />
        ))}
      </div>
    )
  }
  if (error) return <EmptyState variant="error" title="Could not load invoice stats" description={error.message} />

  const existing = data.matched + data.mismatched
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="Invoices approved" value={formatNumber(data.total)} hint={`${formatCurrency(data.invoicedUsd)} invoiced`} icon={Receipt} />
      <StatCard
        label="Matched"
        value={formatNumber(data.matched)}
        hint={existing ? `${formatPercent(data.matched / existing)} of existing orders` : "No existing-order invoices yet"}
        icon={CheckCircle2}
      />
      <StatCard
        label="Mismatched"
        value={formatNumber(data.mismatched)}
        hint={`${formatCurrency(data.absVarianceUsd)} absolute variance`}
        icon={FileWarning}
      />
      <StatCard label="New orders" value={formatNumber(data.new)} hint={`${formatNumber(data.ordersCreated)} created in ORDERS`} icon={FilePlus2} />
    </div>
  )
}
