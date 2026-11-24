import type { EngineInterface, Register } from 'claude-code'

// One JSON object per line. Two kinds:
//   { kind: "prompt",   ts, session_id, project?, remote_session_id?, repos?, prompt }
//   { kind: "response", ts, session_id, project?, remote_session_id?, repos?, turn_id, reason, response, thinking? }
// Prompts are logged when submitted, responses when the turn ends (any reason,
// aborted and errored included), so a long or interrupted turn never loses the
// prompt. remote_session_id is the claude.ai/code session id (session_01...),
// resolved best-effort in cloud sessions; it is also the scry session key.
// repos is the git repositories the session works on,
// [{ name: "owner/repo", url: "https://github.com/owner/repo", branch? }].
const LOG = '$HOME/.claude/chat-log.jsonl'

// HTTP ingestion is driven by three environment variables:
// SCRY_INGEST_URL — the scry ingest endpoint (hotwheels/scry), e.g.
//   https://gagan.ngrok-free.app/ingest. Unset: no HTTP ingestion, local file only.
// SCRY_INGEST_TOKEN — the project's token from scry (New project / Token),
//   sent as Authorization: Bearer <token>.
// SCRY_PROJECT — the scry project these sessions belong to, sent as X-Project.
//   Required by scry: unset, HTTP ingestion is off (local file only) with a
//   one-time warning. Use one project per Claude account to keep their
//   sessions apart.

// The claude.ai/code session id (session_01...), when this is a cloud session.
let remoteSessionId = ''
type Repo = { name: string; url: string; branch?: string }
// The git repositories this session works on; null until resolved.
let repos: Repo[] | null = null
let repoTries = 0

// "owner/repo" from a GitHub-style URL (https, ssh, or the git proxy's
// http://.../git/owner/repo form), without .git; null when it has no such path.
function repoName(url: string): string | null {
  const m = url.trim().replace(/\.git$/, '').match(/[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/)
  return m ? `${m[1]}/${m[2]}` : null
}

// Repos from the get_session result: session_context.sources[].git_repository.url,
// with branches from session_context.outcomes[].git_repository.git_info.
function reposFromSession(r: unknown): Repo[] {
  const texts: string[] = []
  const content = (r as { content?: unknown })?.content
  if (Array.isArray(content)) {
    for (const c of content) if (c && typeof (c as { text?: unknown }).text === 'string') texts.push((c as { text: string }).text)
  }
  for (const t of texts) {
    let o: any
    try { o = JSON.parse(t) } catch { continue }
    const ctx = o?.ccr?.session_context ?? o?.session_context
    if (!ctx) continue
    const out: Repo[] = []
    const branches = new Map<string, string>()
    for (const oc of Array.isArray(ctx.outcomes) ? ctx.outcomes : []) {
      const gi = oc?.git_repository?.git_info
      if (typeof gi?.repo === 'string' && Array.isArray(gi.branches) && typeof gi.branches[0] === 'string') {
        branches.set(gi.repo.toLowerCase(), gi.branches[0])
      }
    }
    for (const src of Array.isArray(ctx.sources) ? ctx.sources : []) {
      const url = src?.git_repository?.url
      if (typeof url !== 'string') continue
      const name = repoName(url)
      if (!name || out.some((x) => x.name === name)) continue
      const branch = branches.get(name.toLowerCase())
      out.push({ name, url: `https://github.com/${name}`, ...(branch ? { branch } : {}) })
    }
    return out
  }
  return []
}

// A browsable https URL for a git remote: git@host:owner/repo and
// https://user@host/owner/repo.git map to https://host/owner/repo; the cloud
// git proxy (http://...@127.0.0.1:port/git/owner/repo) maps to GitHub.
function webUrlOfRemote(url: string, name: string): string {
  const ssh = url.match(/^(?:ssh:\/\/)?[^@/]+@([^:/]+)[:/]/)
  if (ssh) return `https://${ssh[1]}/${name}`
  const http = url.match(/^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\//)
  if (!http || /^(127\.0\.0\.1|localhost)$/.test(http[1] ?? '')) return `https://github.com/${name}`
  return `https://${http[1]}/${name}`
}

// Fallback outside cloud sessions (or when get_session is unavailable): the
// origin remote and current branch of the working directory, if it is a repo.
async function reposFromGit($: EngineInterface): Promise<Repo[]> {
  const r = await $.process.run(
    ['sh', '-c', 'git remote get-url origin 2>/dev/null && git rev-parse --abbrev-ref HEAD 2>/dev/null'],
    { timeoutMs: 5000 },
  )
  const [url, branch] = r.stdout.split('\n').map((l) => l.trim())
  const name = url ? repoName(url) : null
  if (!name) return []
  return [{ name, url: webUrlOfRemote(url ?? '', name), ...(branch && branch !== 'HEAD' ? { branch } : {}) }]
}

// Resolves once; retried on a few logs if nothing was found (the MCP server
// may connect after session start).
async function resolveRepos($: EngineInterface): Promise<void> {
  if (repos !== null && (repos.length > 0 || repoTries >= 3)) return
  repoTries++
  let found: Repo[] = []
  try {
    found = reposFromSession(await $.mcp.call('claude-code-remote', 'get_session'))
  } catch {
    // Not a cloud session, or the server is not connected here.
  }
  if (found.length === 0) {
    try { found = await reposFromGit($) } catch { /* no git */ }
  }
  repos = found
}

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

async function ingest($: EngineInterface, url: string, project: string, line: string, sessionId: string): Promise<void> {
  const headers: Record<string, string> = {
    'X-Session-Id': sessionId,
    'X-Project': project,
    'Content-Type': 'application/x-ndjson',
  }
  const token = await $.env.get('SCRY_INGEST_TOKEN')
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await $.http.fetch(url, { method: 'POST', headers, body: line + '\n' })
  // 402: the scry account's storage plan is full; lines stay queued and go
  // through once the user upgrades.
  if (res.status === 402) throw new Error('HTTP 402: scry storage limit reached, upgrade your plan in scry (Account)')
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
    const project = (await $.env.get('SCRY_PROJECT'))?.trim() ?? ''
    if (project === '') {
      outbox.length = 0
      throw new Error('SCRY_PROJECT is not set')
    }
    // The session key may resolve between queueing and flushing (the first
    // prompt is queued before the transcript holds the attribution reminder),
    // so re-resolve here and prefer it for routing.
    await resolveRemoteSessionId($)
    while (outbox.length > 0) {
      const head = outbox[0]
      if (head === undefined) break
      await ingest($, url, project, head.line, remoteSessionId !== '' ? remoteSessionId : head.sessionId)
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
  await resolveRepos($)
  const sessionId = await $.session.id()
  const project = (await $.env.get('SCRY_PROJECT'))?.trim() ?? ''
  const obj = {
    ts: new Date().toISOString(),
    session_id: sessionId,
    ...(project !== '' ? { project } : {}),
    ...(remoteSessionId !== '' ? { remote_session_id: remoteSessionId } : {}),
    ...(repos !== null && repos.length > 0 ? { repos } : {}),
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
