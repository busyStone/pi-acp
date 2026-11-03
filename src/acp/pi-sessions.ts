import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'
import { promptToSessionTitle } from './translate/prompt.js'

export type PiSessionListItem = {
  sessionId: string
  cwd: string
  title: string | null
  updatedAt: string | null
  sessionFile: string
}

/** Cheap index entry: header metadata + mtime, without reading file tails. */
export type PiSessionIndexItem = {
  sessionId: string
  cwd: string
  sessionFile: string
  mtimeMs: number
}

export type PiSessionFilter = {
  /** When set, only sessions whose cwd matches one of these paths are kept. */
  workspaceAllowlist?: string[]
  /** When set, only sessions newer than this many milliseconds are kept. */
  maxAgeMs?: number
}

const DEFAULT_TAIL_BYTES = 256 * 1024
const DEFAULT_HEAD_BYTES = 8 * 1024
// Bounded head read for title fallback; avoids reading whole (possibly huge) session files.
const DEFAULT_TITLE_HEAD_BYTES = 256 * 1024

function getPiAgentDir(): string {
  // pi supports overriding config dir via PI_CODING_AGENT_DIR.
  // See pi README.
  return process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), '.pi', 'agent')
}

function readSessionDirFromSettings(agentDir: string): string | null {
  const settingsPath = join(agentDir, 'settings.json')
  try {
    if (!existsSync(settingsPath)) return null
    const raw = readFileSync(settingsPath, 'utf8')
    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null

    const sessionDir = (data as Record<string, unknown>).sessionDir
    if (typeof sessionDir !== 'string' || !sessionDir.trim()) return null

    return isAbsolute(sessionDir) ? sessionDir : resolve(agentDir, sessionDir)
  } catch {
    return null
  }
}

export function getPiSessionsDir(): string {
  const agentDir = getPiAgentDir()
  return readSessionDirFromSettings(agentDir) ?? join(agentDir, 'sessions')
}

/** Resolve the optional explicit workspace allowlist file. */
export function getPiWorkspaceListPath(): string {
  const configured = process.env.PI_ACP_WORKSPACES_FILE
  return configured ? resolve(configured) : join(getPiAgentDir(), 'acp-workspaces.json')
}

function readWorkspaceAllowlist(): string[] | null {
  const file = getPiWorkspaceListPath()
  try {
    if (!existsSync(file)) return null
    const data = JSON.parse(readFileSync(file, 'utf8')) as unknown
    const list = Array.isArray(data)
      ? data
      : data !== null && typeof data === 'object' && Array.isArray((data as { workspaces?: unknown }).workspaces)
        ? ((data as { workspaces: unknown[] }).workspaces)
        : null
    if (list === null) return null
    const paths = list
      .map((entry: unknown) =>
        typeof entry === 'string'
          ? entry
          : entry !== null && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string'
            ? (entry as { path: string }).path
            : null
      )
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map(value => resolve(value))
    return paths.length > 0 ? paths : null
  } catch {
    return null
  }
}

export function sessionFilterFromEnv(): PiSessionFilter {
  const days = Number(process.env.PI_ACP_SESSION_DAYS)
  return {
    workspaceAllowlist: readWorkspaceAllowlist() ?? undefined,
    maxAgeMs: Number.isFinite(days) && days > 0 ? days * 86_400_000 : undefined
  }
}

export function applySessionFilter(items: PiSessionIndexItem[], filter: PiSessionFilter): PiSessionIndexItem[] {
  let out = items
  if (filter.workspaceAllowlist !== undefined && filter.workspaceAllowlist.length > 0) {
    const allowed = new Set(filter.workspaceAllowlist.map(path => resolve(path)))
    out = out.filter(item => allowed.has(resolve(item.cwd)))
  }
  if (filter.maxAgeMs !== undefined) {
    const cutoff = Date.now() - filter.maxAgeMs
    out = out.filter(item => item.mtimeMs >= cutoff)
  }
  return out
}

function walkJsonlFiles(dir: string, out: string[]) {
  let entries: import('node:fs').Dirent[]
  try {
    // Force string names.
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' }) as unknown as import('node:fs').Dirent[]
  } catch {
    return
  }

  for (const e of entries) {
    const name = typeof (e as any).name === 'string' ? (e as any).name : String((e as any).name)
    const p = join(dir, name)
    if (e.isDirectory()) walkJsonlFiles(p, out)
    else if (e.isFile() && name.endsWith('.jsonl')) out.push(p)
  }
}

function readFirstLine(path: string): string | null {
  // Avoid reading the whole file.
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(DEFAULT_HEAD_BYTES)
    const n = readSync(fd, buf, 0, buf.length, 0)
    if (n <= 0) return null
    const s = buf.subarray(0, n).toString('utf-8')
    const idx = s.indexOf('\n')
    return idx === -1 ? s.trim() : s.slice(0, idx).trim()
  } catch {
    return null
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
}

function readTail(path: string, tailBytes = DEFAULT_TAIL_BYTES): string {
  const st = statSync(path)
  const start = Math.max(0, st.size - tailBytes)
  const len = st.size - start

  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(len)
    const n = readSync(fd, buf, 0, buf.length, start)
    return buf.subarray(0, n).toString('utf-8')
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
}

function parseSessionHeader(firstLine: string): { sessionId: string; cwd: string } | null {
  try {
    const obj = JSON.parse(firstLine) as any
    if (obj?.type !== 'session') return null
    const sessionId = typeof obj?.id === 'string' ? obj.id : null
    const cwd = typeof obj?.cwd === 'string' ? obj.cwd : null
    if (!sessionId || !cwd) return null
    return { sessionId, cwd }
  } catch {
    return null
  }
}

function pickTitleFromTail(tail: string): string | null {
  // Try to find the *latest* session_info entry (stores the user-provided name).
  // We scan backwards line-by-line.
  const lines = tail.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      if (obj?.type === 'session_info' && typeof obj?.name === 'string') {
        return obj.name.trim()
      }
    } catch {
      // ignore
    }
  }
  return null
}

function scanSessionInfoNameFromFile(path: string): string | null {
  // Fallback when the session_info entry is outside the tail/head windows.
  // Only lines that can contain a name are parsed: parsing every line of a
  // multi-MB transcript was the slow path (~300 ms per file on this machine).
  const maxBytes = Number(process.env.PI_ACP_TITLE_SCAN_MAX_BYTES ?? 8 * 1024 * 1024)
  try {
    const size = statSync(path).size
    if (Number.isFinite(maxBytes) && maxBytes > 0 && size > maxBytes) return null
  } catch {
    return null
  }

  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(256 * 1024)
    let leftover = ''
    let offset = 0
    let lastName: string | null = null

    while (true) {
      const n = readSync(fd, buf, 0, buf.length, offset)
      if (n <= 0) break
      offset += n

      const chunk = leftover + buf.subarray(0, n).toString('utf8')
      const lines = chunk.split(/\r?\n/)
      leftover = lines.pop() ?? ''

      for (const line0 of lines) {
        if (!line0.includes('session_info')) continue
        const line = line0.trim()
        if (!line) continue
        try {
          const obj = JSON.parse(line) as any
          if (obj?.type === 'session_info' && typeof obj?.name === 'string') {
            lastName = obj.name.trim()
          }
        } catch {
          // ignore
        }
      }
    }

    const tailLine = leftover.trim()
    if (tailLine.includes('session_info')) {
      try {
        const obj = JSON.parse(tailLine) as any
        if (obj?.type === 'session_info' && typeof obj?.name === 'string') {
          lastName = obj.name.trim()
        }
      } catch {
        // ignore
      }
    }

    return lastName
  } catch {
    return null
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
}

function pickUpdatedAtFromTail(tail: string): string | null {
  // pi's `/resume` effectively orders sessions by last *message* activity.
  // We scan backwards and pick the timestamp of the most recent entry with type === "message".
  const lines = tail.split(/\r?\n/)

  // 1) Prefer the most recent message entry.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      if (obj?.type !== 'message') continue
      const ts = typeof obj?.timestamp === 'string' ? obj.timestamp : null
      if (!ts) continue
      const d = new Date(ts)
      if (Number.isFinite(d.getTime())) return d.toISOString()
    } catch {
      // ignore
    }
  }

  // 2) Fallback: any valid timestamp (covers sessions that somehow have no messages).
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      const ts = typeof obj?.timestamp === 'string' ? obj.timestamp : null
      if (!ts) continue
      const d = new Date(ts)
      if (Number.isFinite(d.getTime())) return d.toISOString()
    } catch {
      // ignore
    }
  }

  return null
}

function readHeadText(path: string): string | null {
  // Bounded read: only the first DEFAULT_TITLE_HEAD_BYTES bytes are inspected.
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(DEFAULT_TITLE_HEAD_BYTES)
    const n = readSync(fd, buf, 0, buf.length, 0)
    if (n <= 0) return null
    return buf.subarray(0, n).toString('utf-8')
  } catch {
    return null
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
}

function pickSessionInfoNameFromHead(raw: string): string | null {
  const lines = raw.split(/\r?\n/)
  let name: string | null = null
  for (const line0 of lines.slice(0, 2000)) {
    if (!line0.includes('session_info')) continue
    const line = line0.trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      if (obj?.type === 'session_info' && typeof obj?.name === 'string') {
        name = obj.name.trim()
      }
    } catch {
      // ignore
    }
  }
  return name
}

function pickFirstUserTitleFromHead(raw: string): string | null {
  const lines = raw.split(/\r?\n/)
  for (const line0 of lines.slice(0, 2000)) {
    if (!line0.includes('"user"')) continue
    const line = line0.trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      if (obj?.type === 'message' && obj?.message?.role === 'user') {
        const content = obj?.message?.content
        if (typeof content === 'string') {
          const title = promptToSessionTitle([{ type: 'text', text: content }])
          if (title) return title
        }
        if (Array.isArray(content)) {
          const title = promptToSessionTitle(
            content.filter(
              (block: unknown): block is { type: 'text'; text: string } =>
                typeof block === 'object' &&
                block !== null &&
                'type' in block &&
                block.type === 'text' &&
                'text' in block &&
                typeof block.text === 'string'
            )
          )
          if (title) return title
        }
      }
    } catch {
      // ignore
    }
  }
  return null
}

export function readPiSessionTitle(path: string, tail?: string): string | null {
  try {
    // 1) Latest session name (tail), 2) a name anywhere in the file (bounded,
    //    only lines containing session_info are parsed), 3) first user prompt.
    const name = pickTitleFromTail(tail ?? readTail(path)) ?? scanSessionInfoNameFromFile(path)
    return name || pickFirstUserTitleFromHead(readHeadText(path) ?? '')
  } catch {
    return null
  }
}

let sessionIndexCache: { dir: string; builtAt: number; items: PiSessionIndexItem[] } | undefined

function sessionIndexTtlMs(): number {
  const raw = Number(process.env.PI_ACP_SESSION_CACHE_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : 30_000
}

/** Drop the cached index (tests, or after creating/renaming a session). */
export function invalidatePiSessionIndex(): void {
  sessionIndexCache = undefined
}

/**
 * Build (or reuse) a cheap index: one first-line read plus one stat per file.
 * File tails are NOT read here; titles are hydrated per page by the caller.
 */
export function listPiSessionIndex(): PiSessionIndexItem[] {
  const sessionsDir = getPiSessionsDir()
  const ttl = sessionIndexTtlMs()
  const cached = sessionIndexCache
  if (cached !== undefined && cached.dir === sessionsDir && Date.now() - cached.builtAt < ttl) {
    return cached.items
  }

  const files: string[] = []
  walkJsonlFiles(sessionsDir, files)

  const items: PiSessionIndexItem[] = []
  for (const file of files) {
    const first = readFirstLine(file)
    if (!first) continue
    const header = parseSessionHeader(first)
    if (!header) continue
    let mtimeMs = 0
    try {
      mtimeMs = statSync(file).mtimeMs
    } catch {
      mtimeMs = 0
    }
    items.push({ sessionId: header.sessionId, cwd: header.cwd, sessionFile: file, mtimeMs })
  }

  items.sort((a, b) => b.mtimeMs - a.mtimeMs)
  sessionIndexCache = { dir: sessionsDir, builtAt: Date.now(), items }
  return items
}

/**
 * Read titles (and the message timestamp) only for the items actually returned
 * to the client: one tail read per item, then a bounded head fallback.
 */
export function hydratePiSessionTitles(items: PiSessionIndexItem[]): PiSessionListItem[] {
  return items.map(item => {
    let title: string | null = null
    let updatedAt: string | null = null
    try {
      const tail = readTail(item.sessionFile)
      title = readPiSessionTitle(item.sessionFile, tail)
      updatedAt = pickUpdatedAtFromTail(tail)
    } catch {
      // fall through to mtime fallback
    }
    if (!updatedAt) {
      updatedAt = item.mtimeMs > 0 ? new Date(item.mtimeMs).toISOString() : null
    }
    return {
      sessionId: item.sessionId,
      cwd: item.cwd,
      title,
      updatedAt,
      sessionFile: item.sessionFile
    }
  })
}

export function listPiSessions(): PiSessionListItem[] {
  const items = hydratePiSessionTitles(listPiSessionIndex())
  // Preserve the documented ordering: most recent message first.
  items.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  return items
}

export function findPiSession(sessionId: string): PiSessionListItem | null {
  const item = listPiSessionIndex().find(s => s.sessionId === sessionId)
  if (!item) return null
  return hydratePiSessionTitles([item])[0] ?? null
}

export function findPiSessionFile(sessionId: string): string | null {
  return findPiSession(sessionId)?.sessionFile ?? null
}
