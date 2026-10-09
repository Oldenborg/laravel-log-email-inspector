import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { simpleParser } from 'mailparser'
import { renderPreview } from './blade.js'

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

// The Laravel app root; defaults to the directory containing storage/logs/laravel.log
const storageIdx = LOG_PATH.lastIndexOf(`${path.sep}storage${path.sep}`)
const LARAVEL_PATH = process.env.LARAVEL_PATH ?? (storageIdx === -1 ? null : LOG_PATH.slice(0, storageIdx))

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

async function walk(dir) {
  const files = []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return files
    throw err
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(full)))
    else files.push(full)
  }
  return files
}

// Directories whose blade files are considered mail templates even without a class reference
const MAIL_DIR = /(^|\/)(mail|mails|email|emails)(\/|$)/
const MAIL_COMPONENT = /<x-mail::|@component\(\s*['"]mail::/
// Matches ->view('a.b') / ->markdown(...) / ->text(...) and Content(view: 'a.b', markdown: ...)
const VIEW_REF = /(?:->\s*(?:view|markdown|text|html)\s*\(\s*|\b(?:view|markdown|text|html)\s*:\s*)['"]([\w./-]+)['"]/g

// App name shown in the preview's mail theme header/footer, read from the Laravel .env
async function laravelAppName() {
  const env = await fs.readFile(path.join(LARAVEL_PATH, '.env'), 'utf8').catch(() => '')
  const m = env.match(/^APP_NAME=(.*)$/m)
  return m ? m[1].trim().replace(/^(["'])(.*)\1$/, '$2') : 'Laravel'
}

async function loadTemplates() {
  if (!LARAVEL_PATH) return null
  const viewsDir = path.join(LARAVEL_PATH, 'resources', 'views')

  // Map view name ("mail.welcome") -> Mailable/Notification classes referencing it
  const usedBy = new Map()
  for (const dir of ['app/Mail', 'app/Notifications']) {
    for (const file of await walk(path.join(LARAVEL_PATH, dir))) {
      if (!file.endsWith('.php')) continue
      const src = await fs.readFile(file, 'utf8')
      for (const m of src.matchAll(VIEW_REF)) {
        const name = m[1].replace(/\//g, '.')
        if (!usedBy.has(name)) usedBy.set(name, [])
        usedBy.get(name).push({ class: path.basename(file, '.php'), file: path.relative(LARAVEL_PATH, file) })
      }
    }
  }

  const templates = []
  for (const file of await walk(viewsDir)) {
    if (!file.endsWith('.blade.php')) continue
    const rel = path.relative(LARAVEL_PATH, file).split(path.sep).join('/')
    if (rel.startsWith('resources/views/vendor/')) continue // published vendor templates are noise, not app templates
    const name = path.relative(viewsDir, file).replace(/\.blade\.php$/, '').split(path.sep).join('.')
    const source = await fs.readFile(file, 'utf8')
    const markdown = MAIL_COMPONENT.test(source)
    const classes = usedBy.get(name) ?? []
    if (!classes.length && !markdown && !MAIL_DIR.test(rel.slice('resources/views/'.length))) continue
    const stat = await fs.stat(file)
    templates.push({ name, path: rel, markdown, usedBy: classes, size: stat.size, modified: stat.mtime.toISOString(), source })
  }
  templates.sort((a, b) => a.name.localeCompare(b.name))
  templates.forEach((t, i) => (t.id = i))
  return templates
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
      if (url.pathname === '/api/templates') {
        const templates = await loadTemplates()
        if (!templates) {
          res.writeHead(404, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: 'Laravel root not found. Set LARAVEL_PATH in .env (LOG_PATH does not contain /storage/).' }))
        }
        const list = templates.map(({ source, ...rest }) => rest)
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ laravelPath: LARAVEL_PATH, templates: list }))
      }
      const t = url.pathname.match(/^\/api\/templates\/(\d+)$/)
      if (t) {
        const template = ((await loadTemplates()) ?? []).find((x) => x.id === Number(t[1]))
        if (!template) {
          res.writeHead(404, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: 'Not found' }))
        }
        const classes = await Promise.all(
          template.usedBy.map(async (u) => ({ ...u, source: await fs.readFile(path.join(LARAVEL_PATH, u.file), 'utf8').catch(() => '(could not read file)') }))
        )
        let preview
        try {
          preview = renderPreview(template.source, { markdown: template.markdown, appName: await laravelAppName() })
        } catch (err) {
          preview = null
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ...template, classes, preview }))
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
  .listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}`
    console.log(`Laravel Log Email Inspector: ${url}\nReading ${LOG_PATH}`)
    if (process.env.OPEN !== 'false') {
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
      spawn(cmd, [url], { shell: process.platform === 'win32', stdio: 'ignore', detached: true }).on('error', () => {}).unref()
    }
  })
