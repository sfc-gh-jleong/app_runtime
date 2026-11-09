#!/usr/bin/env bash
# End-to-end check of a running app against every test invoice:
#   upload -> AI_EXTRACT -> compare, then compare the status with EXPECTED_RESULTS.md.
# Nothing is approved. Usage: scripts/e2e_check.sh [base_url]
set -euo pipefail
BASE="${1:-http://localhost:3000}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pass=0; fail=0
for pdf in "$ROOT"/test_invoices/{matching,mismatched,new}/*.pdf; do
  rel="${pdf#"$ROOT"/test_invoices/}"
  expected="$(grep -F "\`$rel\`" "$ROOT/test_invoices/EXPECTED_RESULTS.md" | awk -F'|' '{gsub(/ /,"",$3); print $3}')"
  up="$(curl -fsS -F "file=@$pdf;type=application/pdf" "$BASE/api/invoices/upload")"
  path="$(jq -r .filePath <<<"$up")"
  ex="$(curl -fsS -H 'Content-Type: application/json' -d "{\"filePath\":\"$path\"}" "$BASE/api/invoices/extract")"
  cmp="$(jq '{invoice: .invoice}' <<<"$ex" | curl -fsS -H 'Content-Type: application/json' -d @- "$BASE/api/invoices/compare")"
  got="$(jq -r .result.status <<<"$cmp")"
  detail="$(jq -r '[.result.discrepancies[].field] + [.result.issues[] | select(.severity=="blocking") | .message] | join("; ")' <<<"$cmp")"
  if [[ "$got" == "$expected" ]]; then pass=$((pass+1)); mark=PASS; else fail=$((fail+1)); mark=FAIL; fi
  printf '%-4s %-36s expected=%-10s got=%-10s %s\n' "$mark" "$rel" "$expected" "$got" "$detail"
done
echo "passed=$pass failed=$fail"
[[ $fail -eq 0 ]]
