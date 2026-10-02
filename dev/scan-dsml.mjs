/**
 * 扫最近的 DSH 会话日志，找**模型输出**里有没有 DSML / 工具调用标记，以及它落在哪个通道。
 *
 * 为什么需要它：0.6.28 之前的结论是"DSML 从正文通道漏出"，但实机上
 * `diagnostics/rejected-meta.jsonl` **零条记录**（正文通道一次都没解析失败）——
 * 所以要么标记走的是**思考通道**（那条通道不过滤），要么根本没泄漏。
 * 这个脚本给的是事实，不是推断。
 *
 * ⚠️ 会话日志是 **多帧 zstd**（`session.v*.jsonl.zstd`）；Node 的 zstdDecompressSync 只解第一帧，
 * 直接用它只会拿到一行 header、报"没有内容"（假阴性，踩过）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'

const ROOT = process.argv[2] ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'sessions')
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 逐帧解压多帧 zstd：按 magic 切帧，逐帧解，拼起来。 */
function readZstdFrames(buf) {
  const starts = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i)
  }
  if (starts.length === 0) return ''
  const parts = []
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      parts.push(zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8'))
    } catch {
      /* 尾部截断的帧，跳过 */
    }
  }
  return parts.join('\n')
}

function readSession(p) {
  const buf = readFileSync(p)
  if (p.endsWith('.zstd')) return readZstdFrames(buf)
  const s = buf.toString('utf8')
  return s
}

function walk(dir, out, depth = 0) {
  if (depth > 3) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out, depth + 1)
    else if (/^session\.v\d+\.jsonl(\.zstd|\.gz)?$/.test(e.name)) out.push({ p, at: statSync(p).mtimeMs })
  }
}

const files = []
walk(ROOT, files)
files.sort((a, b) => b.at - a.at)
console.log(`会话文件 ${files.length} 个（最近的在前面）`)
console.log('')

// 只看最近 8 个会话
const MARKERS = [
  ['DSML 前缀', /[|｜]{1,2}\s*DSML\s*[|｜]{1,2}/i],
  ['<invoke name=', /<\s*(?:[\w-]+:)?invoke\s+name=/i],
  ['<tool_calls>', /<\s*(?:[\w-]+:)?(?:tool_calls?|function_calls|calls)\s*>/i],
  ['antml:', /antml:/i],
]

let hitTotal = 0
for (const f of files.slice(0, 8)) {
  const text = readSession(f.p)
  if (!text) continue
  const lines = text.split('\n').filter(Boolean)
  const counts = {}
  let hitLines = 0
  const samples = []
  for (const l of lines) {
    let matched = false
    for (const [label, re] of MARKERS) {
      if (re.test(l)) {
        counts[label] = (counts[label] ?? 0) + 1
        matched = true
      }
    }
    if (matched) {
      hitLines++
      if (samples.length < 2) samples.push(l.slice(0, 220))
    }
  }
  const when = new Date(f.at).toISOString().slice(5, 16).replace('T', ' ')
  if (hitLines === 0) {
    console.log(`${when}  ${f.p.split(/[\\/]/).slice(-2)[0].slice(0, 18)}  行 ${String(lines.length).padStart(5)}  无标记`)
  } else {
    hitTotal += hitLines
    console.log(`${when}  ${f.p.split(/[\\/]/).slice(-2)[0].slice(0, 18)}  行 ${String(lines.length).padStart(5)}  ★命中 ${hitLines} 行  ${JSON.stringify(counts)}`)
    for (const s of samples) console.log('        ' + s.replace(/\s+/g, ' '))
  }
}
console.log('')
console.log(hitTotal === 0 ? '结论：最近 8 个会话里没有任何工具调用标记 ⛔' : `结论：共 ${hitTotal} 行含标记`)
