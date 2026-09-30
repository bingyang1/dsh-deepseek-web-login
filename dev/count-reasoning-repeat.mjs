/**
 * 统计「思考里反复复述同一句话」的规模。
 *
 * 事实来源：DSH 会话日志（zstd 多帧，按魔数 0x28B52FFD 切帧后逐帧解压）。
 * 会话日志文件名带版本号（0.2.x 起是 session.v4.jsonl.zstd），别写死。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

const ID = process.argv[2]
const NEEDLE = process.argv[3]
const ROOT = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function findLog(id) {
  const stack = [ROOT]
  while (stack.length) {
    const dir = stack.pop()
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name.startsWith('session-') && e.name.includes(id)) {
          return join(full, readdirSync(full).find((n) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(n)))
        }
        stack.push(full)
      }
    }
  }
}

function inflate(buf) {
  const parts = []
  let start = 0
  while (start < buf.length) {
    const next = buf.indexOf(MAGIC, start + 4)
    const end = next === -1 ? buf.length : next
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(start, end)))
    } catch {}
    start = end
  }
  return Buffer.concat(parts).toString('utf8')
}

const file = findLog(ID)
if (!file) {
  console.error('没找到会话', ID)
  process.exit(2)
}
const text = inflate(readFileSync(file))
const events = []
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  try {
    events.push(JSON.parse(line))
  } catch {}
}

// 收集所有 reasoning 块（按出现顺序）
//
// ⚠️ 只走 `data.message`（组装好的那条），**不要**走 `data.stream` ——
// 同一条 assistant/message 里 reasoning 出现在**两处**（`message.content[i]` 与
// `stream[].chunk.block`），两处都走会把每段思考数成两份，让人误以为"模型想了两遍"。
const reasonings = []
const walk = (node) => {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) return node.forEach(walk)
  if (node.type === 'reasoning' && typeof node.text === 'string') reasonings.push(node.text)
  for (const v of Object.values(node)) walk(v)
}
for (const e of events) walk(e?.data?.message ?? e)

console.log(`文件: ${file.split(/[\\/]/).pop()}`)
console.log(`事件 ${events.length} 条；reasoning 块 ${reasonings.length} 段`)
console.log(`reasoning 总字符 ${reasonings.reduce((a, b) => a + b.length, 0)}`)

if (NEEDLE) {
  const hit = reasonings.filter((t) => t.includes(NEEDLE))
  console.log(`\n含「${NEEDLE}」的 reasoning 块: ${hit.length} / ${reasonings.length} 段`)
  const total = reasonings.reduce((a, t) => a + (t.split(NEEDLE).length - 1), 0)
  console.log(`该句在思考里出现 ${total} 次`)
  console.log('\n各段开头 60 字（看起手式）：')
  reasonings.forEach((t, i) => {
    const head = t.replace(/\s+/g, ' ').slice(0, 60)
    const mark = t.includes(NEEDLE) ? '★' : ' '
    console.log(`  ${String(i + 1).padStart(3)} ${mark} ${head}`)
  })
}
