import { Badge } from "@/components/ui/badge"
import type { LineStatus, MatchStatus } from "@/lib/invoice-types"

const VARIANT: Record<MatchStatus | LineStatus, "success" | "warning" | "default" | "destructive" | "secondary"> = {
  MATCHED: "success",
  MISMATCHED: "warning",
  NEW: "default",
  EXTRA: "destructive",
  MISSING: "destructive",
}

const LABEL: Record<MatchStatus | LineStatus, string> = {
  MATCHED: "Matched",
  MISMATCHED: "Mismatch",
  NEW: "New",
  EXTRA: "Extra line",
  MISSING: "Missing",
}

export function StatusBadge({ status }: { status: MatchStatus | LineStatus | string }) {
  const key = status as MatchStatus | LineStatus
  return <Badge variant={VARIANT[key] ?? "secondary"}>{LABEL[key] ?? status}</Badge>
}
