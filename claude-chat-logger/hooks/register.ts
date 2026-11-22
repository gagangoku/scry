import type { EngineInterface, Register } from 'claude-code'

// One JSON object per line. Two kinds:
//   { kind: "prompt",   ts, session_id, project?, remote_session_id?, prompt }
//   { kind: "response", ts, session_id, project?, remote_session_id?, turn_id, reason, response, thinking? }
// Prompts are logged when submitted, responses when the turn ends (any reason,
// aborted and errored included), so a long or interrupted turn never loses the
// prompt. remote_session_id is the claude.ai/code session id (session_01...),
// resolved best-effort in cloud sessions; it is also the scry session key.
const LOG = '$HOME/.claude/chat-log.jsonl'

// HTTP ingestion is driven by three environment variables:
// SCRY_INGEST_URL — the scry ingest endpoint (hotwheels/scry), e.g.
//   https://gagan.ngrok-free.app/ingest. Unset: no HTTP ingestion, local file only.
// SCRY_INGEST_TOKEN — the project's token from scry (New project / Token).
//   scry is end-to-end encrypted: the token itself is never sent. The plugin
//   derives the project's auth key from it (sent as Authorization: Bearer) and
//   the key that unwraps the project's data key, then encrypts every line
//   before it leaves this machine. Without a token nothing is sent.
// SCRY_PROJECT — the scry project these sessions belong to, sent as X-Project.
//   Required by scry: unset, HTTP ingestion is off (local file only) with a
//   one-time warning. Use one project per Claude account to keep their
//   sessions apart.

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

// <scry-crypto> End-to-end encryption, the scheme in scry's lib/crypto.js:
// HKDF-SHA256 (salt "scry") of the token gives the auth key ("scry/v1/auth")
// and the key-encryption key ("scry/v1/kek"); the kek unwraps the project's
// data key (AES-256-GCM, aad "scry/v1/key:<project>"), and each line is sealed
// with the data key (AES-256-GCM, aad "scry/v1/line:<project>") into
// {"v":1,"iv","ct"}. WebCrypto does the work; where the engine has none, the
// same steps run in a `node` subprocess.
const te = new TextEncoder()
function b64u(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function unb64u(s: string) {
  const t = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(t + '==='.slice((t.length + 3) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
async function hkdf(subtle: SubtleCrypto, token: string, info: string) {
  const base = await subtle.importKey('raw', te.encode(token), 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: te.encode('scry'), info: te.encode(info) }, base, 256))
}
async function webAuthKey(subtle: SubtleCrypto, token: string): Promise<string> {
  return b64u(await hkdf(subtle, token, 'scry/v1/auth'))
}
async function webDataKey(subtle: SubtleCrypto, token: string, project: string, wrappedKey: string): Promise<CryptoKey> {
  const kek = await subtle.importKey('raw', await hkdf(subtle, token, 'scry/v1/kek'), 'AES-GCM', false, ['decrypt'])
  const w = unb64u(wrappedKey)
  const raw = await subtle.decrypt({ name: 'AES-GCM', iv: w.subarray(0, 12), additionalData: te.encode(`scry/v1/key:${project}`) }, kek, w.subarray(12))
  return subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt'])
}
async function webSeal(subtle: SubtleCrypto, key: CryptoKey, project: string, line: string): Promise<string> {
  const iv = new Uint8Array(12)
  globalThis.crypto.getRandomValues(iv)
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(`scry/v1/line:${project}`) }, key, te.encode(line))
  return JSON.stringify({ v: 1, iv: b64u(iv), ct: b64u(new Uint8Array(ct)) })
}
// The same as the functions above, for `node -e`, reading JSON on stdin:
// {op:"auth",token} prints the auth key; {op:"seal",token,project,wrappedKey,lines}
// prints one envelope per line.
const NODE_CRYPTO = `const c=require('crypto');let d='';process.stdin.on('data',x=>d+=x).on('end',()=>{const a=JSON.parse(d);
const h=i=>Buffer.from(c.hkdfSync('sha256',Buffer.from(a.token,'utf8'),Buffer.from('scry'),Buffer.from(i),32));
if(a.op==='auth'){process.stdout.write(h('scry/v1/auth').toString('base64url'));return}
const w=Buffer.from(a.wrappedKey,'base64url');const u=c.createDecipheriv('aes-256-gcm',h('scry/v1/kek'),w.subarray(0,12));
u.setAAD(Buffer.from('scry/v1/key:'+a.project));u.setAuthTag(w.subarray(w.length-16));
const k=Buffer.concat([u.update(w.subarray(12,w.length-16)),u.final()]);
process.stdout.write(a.lines.map(l=>{const iv=c.randomBytes(12);const e=c.createCipheriv('aes-256-gcm',k,iv);
e.setAAD(Buffer.from('scry/v1/line:'+a.project));const ct=Buffer.concat([e.update(l,'utf8'),e.final(),e.getAuthTag()]);
return JSON.stringify({v:1,iv:iv.toString('base64url'),ct:ct.toString('base64url')})}).join('\\n'))})`
// </scry-crypto>

async function nodeCrypto($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const r = await $.process.run(['node', '-e', NODE_CRYPTO], { stdin: JSON.stringify(input), timeoutMs: 15000 })
  if (r.exitCode !== 0) throw new Error(`encryption failed: ${r.stderr.slice(0, 200)}`)
  return r.stdout
}

const subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle

// The project's keys, fetched once per token from <SCRY_INGEST_URL>/key.
type ScryKeys = { url: string; token: string; authKey: string; project: string; wrappedKey: string; dataKey?: CryptoKey }
let scryKeys: ScryKeys | null = null

async function keysFor($: EngineInterface, url: string, token: string): Promise<ScryKeys> {
  if (scryKeys !== null && scryKeys.url === url && scryKeys.token === token) return scryKeys
  const authKey = subtle !== undefined ? await webAuthKey(subtle, token) : await nodeCrypto($, { op: 'auth', token })
  const res = await $.http.fetch(url.replace(/\/+$/, '') + '/key', { headers: { Authorization: `Bearer ${authKey}` } })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching the project key`)
  // Read the body as JSON whichever shape the engine's response has.
  const r = res as unknown as { json?: () => Promise<unknown>; text?: () => Promise<string>; body?: unknown }
  const body = typeof r.json === 'function' ? await r.json()
    : JSON.parse(typeof r.text === 'function' ? await r.text() : String(r.body))
  const { project, wrappedKey } = body as { project: string; wrappedKey: string }
  if (typeof project !== 'string' || typeof wrappedKey !== 'string') throw new Error('scry answered no project key')
  const k: ScryKeys = { url, token, authKey, project, wrappedKey }
  if (subtle !== undefined) k.dataKey = await webDataKey(subtle, token, project, wrappedKey)
  scryKeys = k
  return k
}

async function seal($: EngineInterface, k: ScryKeys, line: string): Promise<string> {
  if (subtle !== undefined && k.dataKey !== undefined) return webSeal(subtle, k.dataKey, k.project, line)
  return nodeCrypto($, { op: 'seal', token: k.token, project: k.project, wrappedKey: k.wrappedKey, lines: [line] })
}

async function ingest($: EngineInterface, url: string, project: string, line: string, sessionId: string): Promise<void> {
  const token = (await $.env.get('SCRY_INGEST_TOKEN'))?.trim() ?? ''
  if (token === '') throw new Error('SCRY_INGEST_TOKEN is not set')
  const k = await keysFor($, url, token)
  if (k.project !== project) throw new Error(`SCRY_INGEST_TOKEN is for project "${k.project}", not SCRY_PROJECT "${project}"`)
  const headers: Record<string, string> = {
    'X-Session-Id': sessionId,
    'X-Project': project,
    'Content-Type': 'application/x-ndjson',
    'Authorization': `Bearer ${k.authKey}`,
  }
  const res = await $.http.fetch(url, { method: 'POST', headers, body: (await seal($, k, line)) + '\n' })
  if (res.status === 401) scryKeys = null // token replaced: refetch next time
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
  const sessionId = await $.session.id()
  const project = (await $.env.get('SCRY_PROJECT'))?.trim() ?? ''
  const obj = {
    ts: new Date().toISOString(),
    session_id: sessionId,
    ...(project !== '' ? { project } : {}),
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
