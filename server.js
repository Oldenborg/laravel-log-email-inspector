import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { simpleParser } from 'mailparser'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
try {
  process.loadEnvFile(path.join(__dirname, '.env'))
} catch (err) {
  if (err.code !== 'ENOENT') throw err
}

const PORT = Number(process.env.PORT ?? 4321)
const LOG_PATH = process.env.LOG_PATH
if (!LOG_PATH) {
  console.error('LOG_PATH is not set. Copy .env.example to .env and set it.')
  process.exit(1)
}

// Laravel log entries start with "[YYYY-MM-DD HH:MM:SS] env.LEVEL: "
const ENTRY_START = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\] (\w+)\.(\w+): /m

let cache = { mtimeMs: 0, size: 0, emails: [] }

function splitEntries(log) {
  const entries = []
  const re = new RegExp(ENTRY_START.source, 'gm')
  const starts = [...log.matchAll(re)]
  starts.forEach((m, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : log.length
    entries.push({ loggedAt: m[1], body: log.slice(m.index + m[0].length, end).replace(/\s+$/, '') })
  })
  return entries
}

// The log mail driver writes the raw RFC822 message as the entry body
const looksLikeMail = (body) => /^From: /.test(body) && /^Message-ID: /m.test(body) && /^MIME-Version: /m.test(body)

const addrs = (a) => (a?.value ?? []).map((x) => ({ name: x.name || '', address: x.address || '' }))

async function parseEntry(entry, index) {
  // The log driver writes bodies already decoded but keeps the quoted-printable header
  const parsed = await simpleParser(entry.body.replace(/^(Content-Transfer-Encoding:\s*)quoted-printable/gim, '$18bit'))
  const text = parsed.text ?? ''
  let html = parsed.html || ''
  // Inline cid: images -> data URIs so the HTML view looks like the mail client
  for (const att of parsed.attachments ?? []) {
    if (att.cid && html) html = html.split(`cid:${att.cid}`).join(`data:${att.contentType};base64,${att.content.toString('base64')}`)
  }
  const preview = text.replace(/[#*>_`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140)
  return {
    id: index,
    messageId: parsed.messageId ?? null,
    loggedAt: entry.loggedAt,
    date: parsed.date ? parsed.date.toISOString() : null,
    subject: parsed.subject ?? '(no subject)',
    preview,
    from: addrs(parsed.from),
    to: addrs(parsed.to),
    cc: addrs(parsed.cc),
    bcc: addrs(parsed.bcc),
    replyTo: addrs(parsed.replyTo),
    text,
    html,
    attachments: (parsed.attachments ?? []).filter((a) => !a.related).map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.size })),
    headers: [...parsed.headerLines].map((h) => h.line),
    source: entry.body,
  }
}

async function loadEmails() {
  const stat = await fs.stat(LOG_PATH)
  if (stat.mtimeMs === cache.mtimeMs && stat.size === cache.size) return cache.emails
  const log = await fs.readFile(LOG_PATH, 'utf8')
  const mails = splitEntries(log).filter((e) => looksLikeMail(e.body))
  const emails = await Promise.all(mails.map((e, i) => parseEntry(e, i)))
  emails.sort((a, b) => (b.date ?? b.loggedAt).localeCompare(a.date ?? a.loggedAt))
  cache = { mtimeMs: stat.mtimeMs, size: stat.size, emails }
  return emails
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    try {
      if (url.pathname === '/api/emails') {
        const emails = await loadEmails()
        // List view only needs summary fields
        const list = emails.map(({ text, html, headers, source, ...rest }) => ({ ...rest, hasHtml: !!html }))
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ logPath: LOG_PATH, emails: list }))
      }
      const m = url.pathname.match(/^\/api\/emails\/(\d+)$/)
      if (m) {
        const email = (await loadEmails()).find((e) => e.id === Number(m[1]))
        res.writeHead(email ? 200 : 404, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(email ?? { error: 'Not found' }))
      }
      const file = url.pathname === '/' ? '/index.html' : url.pathname
      const full = path.join(__dirname, 'public', path.normalize(file))
      if (!full.startsWith(path.join(__dirname, 'public'))) throw Object.assign(new Error('forbidden'), { code: 'EACCES' })
      const data = await fs.readFile(full)
      res.writeHead(200, { 'content-type': TYPES[path.extname(full)] ?? 'application/octet-stream' })
      res.end(data)
    } catch (err) {
      const status = err.code === 'ENOENT' ? 404 : 500
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: err.code === 'ENOENT' ? `Not found: ${err.path ?? url.pathname}` : err.message }))
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`Laravel Log Email Inspector: http://localhost:${PORT}\nReading ${LOG_PATH}`))
