/**
 * POST /api/invoices/extract  { filePath }
 * Runs AI_EXTRACT on a PDF already on @INVOICE_STAGE and returns the normalised
 * invoice, per-field confidence scores and the raw model output.
 */
import { querySnowflakeLongRunning } from "@/lib/snowflake"
import { INVOICE_STAGE, RESPONSE_FORMAT, isValidStagePath, normalizeExtraction } from "@/lib/extract"

export const dynamic = "force-dynamic"

const EXTRACT_SQL = `
SELECT AI_EXTRACT(
  file => TO_FILE('${INVOICE_STAGE}', ?),
  responseFormat => PARSE_JSON(?),
  scores => TRUE
) AS RESULT`

export async function POST(req: Request) {
  try {
    const { filePath } = (await req.json()) as { filePath?: unknown }
    if (!isValidStagePath(filePath)) {
      return Response.json({ error: "Invalid file path" }, { status: 400 })
    }
    const rows = await querySnowflakeLongRunning(EXTRACT_SQL, {
      binds: [filePath, JSON.stringify(RESPONSE_FORMAT)],
    })
    const raw = rows[0]?.RESULT
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
    const { invoice, scores, error } = normalizeExtraction(parsed)
    if (error) {
      return Response.json({ error: `AI_EXTRACT could not read the file: ${error}` }, { status: 422 })
    }
    return Response.json({ invoice, scores, raw: parsed })
  } catch (e) {
    console.error(new Date().toISOString(), "[extract] failed", e)
    return Response.json({ error: e instanceof Error ? e.message : "Extraction failed" }, { status: 500 })
  }
}
