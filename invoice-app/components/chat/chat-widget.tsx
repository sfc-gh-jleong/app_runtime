"use client"

import { useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Bot, Loader2, MessageSquare, RotateCcw, Send, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

interface ChatTable {
  title: string | null
  columns: string[]
  rows: string[][]
  total: number
}

interface Message {
  role: "user" | "assistant"
  text: string
  tables: ChatTable[]
  status?: string
  error?: string
  pending?: boolean
}

const THREAD_KEY = "invoice-app.agent-thread"
const SUGGESTIONS = [
  "How many invoices matched, mismatched, or were new?",
  "Which mismatched invoices have the largest variance?",
  "What are the most common discrepancy types?",
  "What were net sales by channel in FY2025?",
]

export function ChatWidget() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [threadId, setThreadId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    setThreadId(sessionStorage.getItem(THREAD_KEY))
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [messages])

  const updateLast = (fn: (m: Message) => Message) =>
    setMessages((ms) => (ms.length ? [...ms.slice(0, -1), fn(ms[ms.length - 1])] : ms))

  const newChat = () => {
    abortRef.current?.abort()
    sessionStorage.removeItem(THREAD_KEY)
    setThreadId(null)
    setMessages([])
    setBusy(false)
  }

  const send = async (text: string) => {
    const message = text.trim()
    if (!message || busy) return
    setInput("")
    setBusy(true)
    setMessages((ms) => [
      ...ms,
      { role: "user", text: message, tables: [] },
      { role: "assistant", text: "", tables: [], pending: true, status: "Thinking…" },
    ])
    const ctl = new AbortController()
    abortRef.current = ctl
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, threadId }),
        signal: ctl.signal,
      })
      if (!res.ok || !res.body) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json.error ?? `Chat request failed (${res.status})`)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const line = chunk.split("\n").find((l) => l.startsWith("data: "))
          if (!line) continue
          const ev = JSON.parse(line.slice(6))
          switch (ev.type) {
            case "thread":
              sessionStorage.setItem(THREAD_KEY, ev.id)
              setThreadId(ev.id)
              break
            case "status":
              updateLast((m) => ({ ...m, status: ev.message }))
              break
            case "tool":
              updateLast((m) => ({ ...m, status: `Using ${ev.name}…` }))
              break
            case "text":
              updateLast((m) => ({ ...m, text: m.text + ev.delta }))
              break
            case "table":
              updateLast((m) => ({ ...m, tables: [...m.tables, { title: ev.title, columns: ev.columns, rows: ev.rows, total: ev.total }] }))
              break
            case "error":
              updateLast((m) => ({ ...m, error: ev.message }))
              break
            case "done":
              updateLast((m) => ({ ...m, pending: false, status: undefined }))
              break
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        updateLast((m) => ({ ...m, error: e instanceof Error ? e.message : "Chat failed" }))
      }
    } finally {
      updateLast((m) => ({ ...m, pending: false, status: undefined }))
      setBusy(false)
    }
  }

  return (
    <>
      <Button
        onClick={() => setOpen((o) => !o)}
        size="lg"
        aria-label={open ? "Close assistant" : "Ask the Summit Retail agent"}
        className="fixed bottom-5 right-5 z-50 h-14 w-14 rounded-full p-0 shadow-lg"
      >
        {open ? <X className="h-6 w-6" /> : <MessageSquare className="h-6 w-6" />}
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label="Summit Retail agent chat"
          className="fixed bottom-24 right-5 z-50 flex h-[min(640px,calc(100vh-8rem))] w-[min(440px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-xl border bg-card shadow-2xl animate-in fade-in slide-in-from-bottom-2 motion-reduce:animate-none"
        >
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Bot className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">Summit Retail Analyst</p>
              <p className="truncate text-xs text-muted-foreground">Invoices, reconciliation and retail sales</p>
            </div>
            <Button variant="ghost" size="icon" aria-label="New conversation" onClick={newChat} disabled={!messages.length && !threadId}>
              <RotateCcw className="h-4 w-4" />
            </Button>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {messages.length === 0 && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">Ask about approved invoices, mismatches, or Summit Outfitters sales.</p>
                <div className="flex flex-col gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:border-primary hover:bg-primary/5"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "min-w-0 max-w-[92%] rounded-lg px-3 py-2 text-sm",
                    m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted",
                  )}
                >
                  {m.role === "user" ? (
                    <p className="whitespace-pre-wrap break-words">{m.text}</p>
                  ) : (
                    <div className="space-y-2">
                      {m.text && (
                        <div className="prose-chat break-words">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                        </div>
                      )}
                      {m.tables.map((t, ti) => (
                        <div key={ti} className="overflow-hidden rounded-md border bg-card">
                          {t.title && <p className="border-b px-2 py-1 text-xs font-medium">{t.title}</p>}
                          <Table>
                            <TableHeader>
                              <TableRow>
                                {t.columns.map((c) => (
                                  <TableHead key={c} className="whitespace-nowrap text-[11px]">
                                    {c}
                                  </TableHead>
                                ))}
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {t.rows.map((r, ri) => (
                                <TableRow key={ri}>
                                  {r.map((v, vi) => (
                                    <TableCell key={vi} className="whitespace-nowrap py-1 text-xs">
                                      {v ?? "—"}
                                    </TableCell>
                                  ))}
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                          {t.total > t.rows.length && (
                            <p className="px-2 py-1 text-[11px] text-muted-foreground">
                              Showing {t.rows.length} of {t.total} rows
                            </p>
                          )}
                        </div>
                      ))}
                      {m.pending && (
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          {m.status ?? "Working…"}
                        </p>
                      )}
                      {m.error && <p className="text-xs text-destructive">{m.error}</p>}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          <form
            className="flex items-end gap-2 border-t p-3"
            onSubmit={(e) => {
              e.preventDefault()
              void send(input)
            }}
          >
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  void send(input)
                }
              }}
              placeholder="Ask a question…"
              rows={1}
              maxLength={4000}
              className="max-h-32 min-h-10 resize-none"
              aria-label="Message"
            />
            <Button type="submit" size="icon" disabled={busy || !input.trim()} aria-label="Send">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </form>
        </div>
      )}
    </>
  )
}
