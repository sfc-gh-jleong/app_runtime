/**
 * POST /api/invoices/upload  (multipart/form-data, field "file")
 * Stores the PDF on @INVOICE_STAGE via the UPLOAD_INVOICE procedure and returns
 * its stage path. Runs with the app's owner role.
 */
import { querySnowflake } from "@/lib/snowflake"
import { isValidStagePath } from "@/lib/extract"
import { SCHEMA } from "@/lib/invoice-data"

export const dynamic = "force-dynamic"

const MAX_BYTES = 10 * 1024 * 1024

export async function POST(req: Request) {
  try {
    const form = await req.formData()
    const file = form.get("file")
    if (!(file instanceof File)) {
      return Response.json({ error: "Attach a PDF in the 'file' field" }, { status: 400 })
    }
    if (file.size === 0 || file.size > MAX_BYTES) {
      return Response.json({ error: "PDF must be between 1 byte and 10 MB" }, { status: 400 })
    }
    const bytes = Buffer.from(await file.arrayBuffer())
    if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
      return Response.json({ error: "File is not a PDF" }, { status: 400 })
    }

    const rows = await querySnowflake(`CALL ${SCHEMA}.UPLOAD_INVOICE(?, ?)`, {
      binds: [file.name, bytes.toString("base64")],
    })
    const filePath = String(rows[0]?.UPLOAD_INVOICE ?? "")
    if (!isValidStagePath(filePath)) {
      throw new Error(`Unexpected stage path from UPLOAD_INVOICE: ${filePath}`)
    }
    return Response.json({ filePath, fileName: file.name })
  } catch (e) {
    console.error(new Date().toISOString(), "[upload] failed", e)
    return Response.json({ error: e instanceof Error ? e.message : "Upload failed" }, { status: 500 })
  }
}
