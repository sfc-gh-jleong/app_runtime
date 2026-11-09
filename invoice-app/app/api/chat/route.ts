/**
 * POST /api/chat  { message, threadId? }
 * Streams a SUMMIT_RETAIL_AGENT turn (Cortex Agent SDK) to the browser as SSE:
 *   {type:"thread", id} {type:"status", message} {type:"tool", name}
 *   {type:"text", delta} {type:"table", title, columns, rows} {type:"error", message} {type:"done"}
 * The conversation thread persists in Snowflake, so passing threadId continues it.
 */
import { AGENT, getAgentClient } from "@/lib/agent"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const MAX_MESSAGE = 4000
const MAX_TABLE_ROWS = 200

type Emit = (payload: Record<string, unknown>) => void

function emitEvent(ev: Record<string, any>, emit: Emit, state: { lastIndex: number | null }) {
  switch (ev.event) {
    case "response.text.delta": {
      // Separate distinct text blocks (e.g. before and after a tool call).
      const sep = state.lastIndex !== null && ev.content_index !== state.lastIndex ? "\n\n" : ""
      state.lastIndex = ev.content_index ?? state.lastIndex
      if (ev.text) emit({ type: "text", delta: sep + ev.text })
      break
    }
    case "response.status":
      if (ev.message) emit({ type: "status", message: ev.message })
      break
    case "response.tool_use":
      if (ev.name) emit({ type: "tool", name: ev.name })
      break
    case "response.table": {
      const rs = ev.result_set
      const columns: string[] = (rs?.resultSetMetaData?.rowType ?? []).map((c: { name: string }) => c.name)
      const rows: string[][] = (rs?.data ?? []).slice(0, MAX_TABLE_ROWS)
      if (columns.length) emit({ type: "table", title: ev.title ?? null, columns, rows, total: rs?.data?.length ?? rows.length })
      break
    }
    case "error":
      emit({ type: "error", message: ev.message ?? "Agent error" })
      break
  }
}

export async function POST(req: Request) {
  let message: string
  let threadId: string | null
  try {
    const body = (await req.json()) as { message?: unknown; threadId?: unknown }
    message = typeof body.message === "string" ? body.message.trim() : ""
    threadId = typeof body.threadId === "string" && /^\d{1,30}$/.test(body.threadId) ? body.threadId : null
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 })
  }
  if (!message || message.length > MAX_MESSAGE) {
    return Response.json({ error: `Message must be 1-${MAX_MESSAGE} characters` }, { status: 400 })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const emit: Emit = (payload) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
      try {
        const client = getAgentClient()
        const convo = threadId
          ? await client.conversations.attach(threadId, { agent: AGENT })
          : await client.conversations.create({ thread: { origin_application: "invoice_recon" }, agent: AGENT })
        emit({ type: "thread", id: convo.id })

        const turn = await convo.send(message)
        const state = { lastIndex: null as number | null }
        for await (const ev of turn.events()) {
          if (req.signal.aborted) {
            await turn.cancel().catch(() => undefined)
            break
          }
          emitEvent(ev as Record<string, any>, emit, state)
        }
      } catch (e) {
        console.error(new Date().toISOString(), "[chat] agent turn failed", e)
        emit({ type: "error", message: e instanceof Error ? e.message : "Agent request failed" })
      } finally {
        emit({ type: "done" })
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  })
}
