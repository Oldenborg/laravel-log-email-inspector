// Approximate Blade renderer: previews mail templates without running the Laravel app.
// Directives are resolved statically (@if keeps its first branch, loops render once),
// echoes become {placeholder} tokens, and <x-mail::*> components are rendered with a
// replica of Laravel's default mail theme.
import { marked } from 'marked'

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// Blade directives we understand; anything else (e.g. @media in CSS) is left alone
const DIRECTIVES = new Set([
  'if', 'elseif', 'else', 'endif', 'unless', 'endunless', 'isset', 'endisset', 'empty', 'endempty',
  'auth', 'endauth', 'guest', 'endguest', 'error', 'enderror', 'foreach', 'endforeach',
  'forelse', 'endforelse', 'for', 'endfor', 'while', 'endwhile', 'switch', 'case', 'break', 'default', 'endswitch',
  'push', 'endpush', 'once', 'endonce', 'section', 'endsection', 'component', 'endcomponent',
  'include', 'includeIf', 'includeWhen', 'extends', 'yield', 'csrf', 'lang', 'json',
])
const OPENERS = { if: 'endif', unless: 'endunless', isset: 'endisset', empty: 'endempty', auth: 'endauth', guest: 'endguest', error: 'enderror', foreach: 'endforeach', forelse: 'endforelse', for: 'endfor', while: 'endwhile', switch: 'endswitch', push: 'endpush' }
const ENDERS = new Set(Object.values(OPENERS))

// Consume a balanced (...) group starting at s[i], respecting quoted strings
function consumeParens(s, i) {
  let depth = 0, quote = null
  for (; i < s.length; i++) {
    const c = s[i]
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null }
    else if (c === "'" || c === '"') quote = c
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i + 1
  }
  return i
}

function tokenize(src) {
  const tokens = []
  const re = /(?<!@)@(\w+)/g
  let last = 0, m
  while ((m = re.exec(src))) {
    if (!DIRECTIVES.has(m[1])) continue
    let end = re.lastIndex, k = end
    while (src[k] === ' ' || src[k] === '\t') k++
    const parens = src[k] === '('
    if (parens) end = consumeParens(src, k)
    tokens.push({ text: src.slice(last, m.index) }, { dir: m[1], parens })
    last = re.lastIndex = end
  }
  tokens.push({ text: src.slice(last) })
  return tokens
}

// Advance to the matching `end` directive at the current nesting depth, return index after it
function skipPast(tokens, i, end) {
  let depth = 0
  for (; i < tokens.length; i++) {
    const t = tokens[i]
    if (!t.dir) continue
    if (depth === 0 && t.dir === end) return i + 1
    if (OPENERS[t.dir] && (t.dir !== 'empty' || t.parens)) depth++
    else if (ENDERS.has(t.dir)) depth--
  }
  return i
}

function renderTokens(tokens, i, stop) {
  let out = ''
  while (i < tokens.length) {
    const t = tokens[i]
    if (!t.dir) { out += t.text; i++; continue }
    const d = t.dir
    if (stop.includes(d) && (d !== 'empty' || !t.parens)) return [out, i]
    if (d === 'if' || d === 'unless' || d === 'isset' || d === 'auth' || d === 'guest' || d === 'error' || (d === 'empty' && t.parens)) {
      // Keep the first branch, drop @elseif/@else branches
      const end = OPENERS[d]
      const [body, j] = renderTokens(tokens, i + 1, ['elseif', 'else', end])
      out += body
      i = skipPast(tokens, j, end)
    } else if (d === 'foreach' || d === 'for' || d === 'while') {
      const [body, j] = renderTokens(tokens, i + 1, [OPENERS[d]])
      out += body
      i = j + 1
    } else if (d === 'forelse') {
      const [body, j] = renderTokens(tokens, i + 1, ['empty', 'endforelse'])
      out += body
      i = skipPast(tokens, j, 'endforelse')
    } else if (d === 'switch') {
      while (i < tokens.length && !(tokens[i].dir === 'case' || tokens[i].dir === 'default' || tokens[i].dir === 'endswitch')) i++
      if (tokens[i]?.dir !== 'endswitch') {
        const [body, j] = renderTokens(tokens, i + 1, ['case', 'default', 'break', 'endswitch'])
        out += body
        i = j
      }
      i = skipPast(tokens, i, 'endswitch')
    } else if (d === 'push') {
      i = skipPast(tokens, i + 1, 'endpush')
    } else {
      i++ // standalone directive (@include, @csrf, …) or stray marker: drop it, keep surrounding content
    }
  }
  return [out, i]
}

const resolveDirectives = (src) => renderTokens(tokenize(src), 0, [])[0]

// {{ $phoneMessage->caller_name }} -> {phoneMessage.caller_name}
function makeToken(appName) {
  return (expr) => {
    let t = expr.trim()
    if (/^config\(\s*['"]app\.name['"]\s*\)$/.test(t)) return esc(appName)
    t = t.replace(/\$/g, '').replace(/->|::/g, '.').replace(/\s+/g, ' ')
    if (t.length > 48) t = t.slice(0, 48) + '…'
    return `{${esc(t)}}`
  }
}

function dedent(s) {
  const lines = s.split('\n')
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)[0].length)
  const min = indents.length ? Math.min(...indents) : 0
  return lines.map((l) => l.slice(min)).join('\n')
}

const BUTTON_COLORS = { primary: '#2d3748', success: '#48bb78', error: '#e53e3e' }

function button(url, color, label) {
  const bg = BUTTON_COLORS[color] ?? BUTTON_COLORS.primary
  return `\n\n<table align="center" width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:30px auto;text-align:center;"><tr><td align="center"><a href="${esc(url)}" style="display:inline-block;background-color:${bg};border-radius:4px;color:#ffffff;font-size:16px;font-weight:bold;text-decoration:none;padding:8px 18px;">${esc(label)}</a></td></tr></table>\n\n`
}

// Value of an x-mail attribute: url="https://…" or :url="$invoice->link"
function attrValue(attrs, name, token) {
  const m = attrs.match(new RegExp(`(:?)${name}\\s*=\\s*"([^"]*)"`))
  if (!m) return ''
  return m[1] === ':' ? token(m[2]) : m[2]
}

function mailComponents(s, token) {
  const subcopies = []
  // Legacy @component('mail::…') syntax
  s = s.replace(/@component\(\s*['"]mail::button['"]\s*(?:,\s*\[(.*?)\])?\s*\)([\s\S]*?)@endcomponent/g, (_, arr, label) => {
    const url = (arr ?? '').match(/['"]url['"]\s*=>\s*(['"]?)([^,\]'"]+)\1/)
    const color = (arr ?? '').match(/['"]color['"]\s*=>\s*['"](\w+)['"]/)
    return button(url ? (url[1] ? url[2] : token(url[2])) : '#', color?.[1], label.trim())
  })
  s = s.replace(/@component\(\s*['"]mail::panel['"]\s*\)([\s\S]*?)@endcomponent/g, (_, c) => panel(c))
  s = s.replace(/@component\(\s*['"]mail::subcopy['"]\s*\)([\s\S]*?)@endcomponent/g, (_, c) => { subcopies.push(c); return '' })
  // <x-mail::…> syntax
  s = s.replace(/<x-mail::button\b([^>]*)>([\s\S]*?)<\/x-mail::button>/g, (_, attrs, label) => button(attrValue(attrs, 'url', token) || '#', attrValue(attrs, 'color', token), label.trim()))
  s = s.replace(/<x-mail::panel\s*\/?>([\s\S]*?)<\/x-mail::panel>/g, (_, c) => panel(c))
  s = s.replace(/<x-mail::subcopy\s*>([\s\S]*?)<\/x-mail::subcopy>/g, (_, c) => { subcopies.push(c); return '' })
  s = s.replace(/<\/?x-mail::table\s*>/g, '') // slot is a markdown table, marked handles it
  return { body: s, subcopy: subcopies.map((c) => marked.parse(dedent(c).trim())).join('') }
}

function panel(content) {
  return `\n\n<div style="background-color:#edf2f7;border-left:4px solid #cbd5e0;border-radius:4px;margin:21px 0;padding:14px 16px;">${marked.parse(dedent(content).trim())}</div>\n\n`
}

const THEME = `
  body { margin:0; padding:0; width:100%; background-color:#edf2f7; -webkit-text-size-adjust:none; }
  body, td, p, h1, h2, h3 { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }
  h1 { font-size:18px; font-weight:bold; color:#3d4852; margin-top:0; }
  h2 { font-size:16px; font-weight:bold; color:#3d4852; margin-top:0; }
  p { font-size:16px; line-height:1.5em; color:#3d4852; margin-top:0; }
  a { color:#3869d4; }
  td.content-cell table:not([role=presentation]) { width:100%; border-collapse:collapse; margin:15px 0; }
  td.content-cell table:not([role=presentation]) th { border-bottom:1px solid #edeff2; padding-bottom:8px; text-align:left; font-size:14px; color:#3d4852; }
  td.content-cell table:not([role=presentation]) td { padding:10px 0; font-size:14px; line-height:18px; color:#74787e; }
`

function layout(appName, content, subcopy) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${THEME}</style></head>
<body><table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#edf2f7;"><tr><td align="center" style="padding:0 15px;">
<table width="570" cellpadding="0" cellspacing="0" role="presentation" style="width:570px;max-width:100%;">
<tr><td style="padding:25px 0;text-align:center;"><span style="font-size:19px;font-weight:bold;color:#3d4852;">${esc(appName)}</span></td></tr>
<tr><td class="content-cell" style="background-color:#ffffff;border:1px solid #e8e5ef;border-radius:2px;padding:32px;">
${content}
${subcopy ? `<div style="border-top:1px solid #e8e5ef;margin-top:25px;padding-top:25px;font-size:14px;color:#718096;">${subcopy}</div>` : ''}
</td></tr>
<tr><td style="padding:32px;text-align:center;font-size:12px;color:#b0adc5;">© ${new Date().getFullYear()} ${esc(appName)}. All rights reserved.</td></tr>
</table></td></tr></table></body></html>`
}

export function renderPreview(source, { markdown, appName = 'Laravel' } = {}) {
  const token = makeToken(appName)
  let s = source.replace(/\{\{--[\s\S]*?--\}\}/g, '').replace(/@php[\s\S]*?@endphp/g, '')
  // The mail::message wrapper marks a markdown template; previewed inside the default theme layout
  const wrapper = s.match(/<x-mail::message\s*>([\s\S]*?)<\/x-mail::message>/) ?? s.match(/@component\(\s*['"]mail::message['"]\s*\)([\s\S]*)@endcomponent/)
  if (wrapper) s = wrapper[1]
  s = resolveDirectives(s)
  s = s.replace(/\{\{\s*([\s\S]*?)\s*\}\}/g, (_, e) => token(e)).replace(/\{!!\s*([\s\S]*?)\s*!!\}/g, (_, e) => token(e))
  if (!markdown && !wrapper) return s // plain HTML view: what you see is what gets sent
  const { body, subcopy } = mailComponents(s, token)
  return layout(appName, marked.parse(dedent(body).trim()), subcopy)
}
