import type { EngineInterface, Register } from 'claude-code'

// One JSON object per line. Two kinds:
//   { kind: "prompt",   ts, session_id, remote_session_id?, prompt }
//   { kind: "response", ts, session_id, remote_session_id?, turn_id, reason, response, thinking? }
// Prompts are logged when submitted, responses when the turn ends (any reason,
// aborted and errored included), so a long or interrupted turn never loses the
// prompt. remote_session_id is the claude.ai/code session id (session_01...),
// resolved best-effort in cloud sessions; it is also the scry session key.
const LOG = '$HOME/.claude/chat-log.jsonl'

// HTTP ingestion is driven by two environment variables:
// SCRY_INGEST_URL — the scry ingest endpoint (hotwheels/scry), e.g.
//   https://gagan.ngrok-free.app/ingest. Unset: no HTTP ingestion, local file only.
// SCRY_INGEST_TOKEN — sent as Authorization: Bearer <token> when set.

// The claude.ai/code session id (session_01...), when this is a cloud session.
let remoteSessionId = ''
// Streamed thinking per main-loop turn, attached to that turn's response line.
const thinkingByTurn = new Map<string, string>()

// Resolves lazily: retried on each log until found. Primary is the
// claude-code-remote MCP server's get_session; where that server is not
// engine-connected, the fallback scans the transcript for the harness's
// attribution reminder, anchored on "Claude-Session:" so a user-pasted
// session URL never matches.
async function resolveRemoteSessionId($: EngineInterface): Promise<void> {
  if (remoteSessionId !== '') return
  try {
    const r = await $.mcp.call('claude-code-remote', 'get_session')
    const m = JSON.stringify(r.content).match(/session_01[A-Za-z0-9]+/)
    if (m) {
      remoteSessionId = m[0]
      return
    }
  } catch {
    // Server not connected here; try the transcript.
  }
  try {
    const msgs = await $.session.messages({ as: 'api' })
    if (Array.isArray(msgs)) {
      for (const msg of msgs) {
        const m = JSON.stringify(msg).match(/Claude-Session: https:\/\/claude\.ai\/code\/(session_01[A-Za-z0-9]+)/)
        if (m && m[1] !== undefined) {
          remoteSessionId = m[1]
          return
        }
      }
    }
  } catch {
    // Not a cloud session: keep the UUID.
  }
}

async function appendLine($: EngineInterface, line: string): Promise<void> {
  const r = await $.process.run(
    ['sh', '-c', `mkdir -p "$HOME/.claude" && cat >> "${LOG}"`],
    { stdin: line + '\n', timeoutMs: 10000 },
  )
  if (r.exitCode !== 0) throw new Error(r.stderr.slice(0, 300))
}

async function ingest($: EngineInterface, url: string, line: string, sessionId: string): Promise<void> {
  const headers: Record<string, string> = { 'X-Session-Id': sessionId, 'Content-Type': 'application/x-ndjson' }
  const token = await $.env.get('SCRY_INGEST_TOKEN')
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await $.http.fetch(url, { method: 'POST', headers, body: line + '\n' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

// Lines waiting to be uploaded to scry. Hooks only queue and set a timer: a
// timer runs as a dispatch of its own, so the upload never holds the turn or
// prompt path. Failed lines stay queued and retry on the next flush; the local
// JSONL already has them either way.
const outbox: { line: string; sessionId: string }[] = []
const MAX_OUTBOX = 500
let flushing = false
// Warn once per session when the scry endpoint is unreachable, then stay quiet.
let warnedIngest = false

async function flushOutbox($: EngineInterface): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    const url = await $.env.get('SCRY_INGEST_URL')
    if (!url) {
      outbox.length = 0
      return
    }
    // The session key may resolve between queueing and flushing (the first
    // prompt is queued before the transcript holds the attribution reminder),
    // so re-resolve here and prefer it for routing.
    await resolveRemoteSessionId($)
    while (outbox.length > 0) {
      const head = outbox[0]
      if (head === undefined) break
      await ingest($, url, head.line, remoteSessionId !== '' ? remoteSessionId : head.sessionId)
      outbox.shift()
    }
  } catch (err) {
    if (!warnedIngest) {
      warnedIngest = true
      void $.ui.toast(`chat-logger: scry ingest failed, logging locally only (${err instanceof Error ? err.message : String(err)})`)
    }
  } finally {
    flushing = false
  }
}

// Appends locally and queues for scry. Local append errors toast; they never
// fail the calling hook.
async function logLine($: EngineInterface, fields: Record<string, unknown>): Promise<void> {
  await resolveRemoteSessionId($)
  const sessionId = await $.session.id()
  const obj = {
    ts: new Date().toISOString(),
    session_id: sessionId,
    ...(remoteSessionId !== '' ? { remote_session_id: remoteSessionId } : {}),
    ...fields,
  }
  const line = JSON.stringify(obj)
  try {
    await appendLine($, line)
  } catch (err) {
    void $.ui.toast(`chat-logger: save failed (${err instanceof Error ? err.message : String(err)})`)
  }
  if (outbox.length < MAX_OUTBOX) outbox.push({ line, sessionId: remoteSessionId !== '' ? remoteSessionId : sessionId })
  void $.clock.after(1, () => { void flushOutbox($) })
}

async function searchLines($: EngineInterface, query: string): Promise<string[]> {
  // -F: fixed string, -i: case-insensitive; query passed as $1, never interpolated.
  const r = await $.process.run(
    ['sh', '-c', `grep -i -F -- "$1" "${LOG}" | tail -n 10`, 'sh', query],
    { timeoutMs: 15000 },
  )
  if (r.exitCode > 1) throw new Error(r.stderr.slice(0, 300)) // 1 = no matches
  return r.stdout.split('\n').filter((l) => l !== '')
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + ' …' : s)

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'chat-search',
      description: 'Search saved prompts and responses: /chat-search <text>',
    })
    await resolveRemoteSessionId($)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!e.isMeta) await logLine($, { kind: 'prompt', prompt: e.text })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    for await (const c of next(e)) {
      if (c.kind === 'thinking' && c.text !== '' && e.agentId === undefined) {
        if (!thinkingByTurn.has(e.turnId) && thinkingByTurn.size >= 50) thinkingByTurn.clear()
        thinkingByTurn.set(e.turnId, (thinkingByTurn.get(e.turnId) ?? '') + c.text)
      }
      yield c
    }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // Main loop only; subagent turns carry agentId.
    if (!e.agentId) {
      const thinking = thinkingByTurn.get(e.turnId)
      thinkingByTurn.delete(e.turnId)
      if (e.answer !== '' || (thinking !== undefined && thinking !== '')) {
        await logLine($, {
          kind: 'response',
          turn_id: e.turnId,
          reason: e.reason,
          response: e.answer,
          ...(thinking !== undefined && thinking !== '' ? { thinking } : {}),
        })
      }
    }
    return result
  })

  on('command.run', { command: 'chat-search' }, async ($, e) => {
    const query = e.args.trim()
    if (query === '') return { text: 'Usage: /chat-search <text>' }
    try {
      const lines = await searchLines($, query)
      if (lines.length === 0) return { text: `No matches for "${query}".` }
      const blocks = lines.map((line) => {
        try {
          const x = JSON.parse(line) as Record<string, string>
          const sid = x['remote_session_id'] ?? x['session_id'] ?? ''
          if (x['kind'] === 'prompt') return `${x['ts']}  ${sid.slice(0, 24)}\n  prompt:   ${clip(x['prompt'] ?? '', 200)}`
          return `${x['ts']}  ${sid.slice(0, 24)} (${x['reason']})\n  response: ${clip(x['response'] ?? '', 300)}${x['thinking'] !== undefined ? `\n  thinking: ${clip(x['thinking'], 200)}` : ''}`
        } catch {
          return clip(line, 300)
        }
      })
      return { text: `${blocks.length} match(es) for "${query}":\n\n${blocks.join('\n\n')}` }
    } catch (err) {
      return { text: `Search failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  })
}
