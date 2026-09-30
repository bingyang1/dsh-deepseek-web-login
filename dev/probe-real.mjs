/**
 * 只读探活：用账号库里的真实凭证直接打 users/current，看服务端到底返回什么。
 * 零额度、不生成内容。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DS_BASE = 'https://chat.deepseek.com'
const dir = path.join(os.homedir(), '.dsh', 'web-login', 'accounts')
const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()

for (const f of files) {
  const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
  const headers = {
    'user-agent': rec.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'content-type': 'application/json',
    origin: DS_BASE,
    referer: `${DS_BASE}/`,
    'x-client-platform': 'web',
    'x-client-version': '2.0.0',
    'x-app-version': '2.0.0',
    authorization: `Bearer ${rec.token}`,
    'x-deepseek-harness': 'deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness); provider=deepseek-web',
  }
  if (rec.cookie) headers.cookie = rec.cookie
  let out
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 20000)
    const resp = await fetch(`${DS_BASE}/api/v0/users/current`, { headers, signal: ctrl.signal })
    clearTimeout(t)
    const text = await resp.text()
    let body = text.slice(0, 260).replace(/\s+/g, ' ')
    out = `HTTP ${resp.status} | ${body}`
  } catch (e) {
    out = `THROW ${e?.name}: ${e?.message} | cause=${e?.cause?.code || e?.cause?.message || '-'}`
  }
  console.log(`${f.padEnd(22)} ${out}`)
}
