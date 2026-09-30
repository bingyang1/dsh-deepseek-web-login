/**
 * 验证「full 模式下，模型每轮到底看到了什么」—— 用真实会话的原始消息重放一遍序列化。
 *
 * 目的：把两个被混为一谈的东西分开
 *   ① **对话记忆**：DSH 的窗口上下文（用户说了什么、模型答了什么、工具返回了什么）
 *   ② **模型自己上一轮的思考**（reasoning）
 *
 * 做法：从会话日志里按顺序取出 `user/message` / `assistant/message`（含 content 块），
 * 原样喂给插件自己的 `serializePromptParts()`，然后检查产物里：
 *   - 用户消息在不在？工具结果在不在？（＝记忆在不在）
 *   - 模型上一轮的 reasoning 原文在不在？（＝思考有没有被回传）
 *
 * 注意：本脚本不联网、只读本机会话日志。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { serializePromptParts } from '../src/protocol.ts'

const ROOT = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function find(id) {
  const st = [ROOT]
  while (st.length) {
    const d = st.pop()
    let es = []
    try {
      es = readdirSync(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of es) {
      const f = join(d, e.name)
      if (e.isDirectory()) {
        if (e.name.startsWith('session-') && e.name.includes(id)) {
          return join(f, readdirSync(f).find((n) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(n)))
        }
        st.push(f)
      }
    }
  }
}

function inflate(b) {
  const out = []
  let s = 0
  while (s < b.length) {
    const n = b.indexOf(MAGIC, s + 4)
    const e = n === -1 ? b.length : n
    try {
      out.push(zlib.zstdDecompressSync(b.subarray(s, e)))
    } catch {}
    s = e
  }
  return Buffer.concat(out).toString('utf8')
}

const events = []
for (const line of inflate(readFileSync(find(process.argv[2]))).split('\n')) {
  if (!line.trim()) continue
  try {
    events.push(JSON.parse(line))
  } catch {}
}

// 取第一个 turn 的前若干条消息就够说明问题（避免整段会话太大）
let system = ''
const messages = []
const reasonings = [] // 每条 assistant 的思考原文（用于后面反查）
// ⚠️ 两种事件形态不一样（第一版就是在这里漏掉了用户消息）：
//   assistant/message → `data.message.{role,content}`
//   user/message      → `data.{role,content}`（**没有** message 这一层）
//   `agent/inbox/spliced` 是同一份用户输入的"投递记录"，跳过它免得重复计入。
for (const ev of events) {
  if (ev?.type === 'agent/inbox/spliced') continue
  const m = ev?.data?.message ?? ev?.data
  if (!m || typeof m !== 'object') continue
  if (m.role === 'system' && !system) {
    system = (m.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('')
    continue
  }
  if (m.role !== 'user' && m.role !== 'assistant') continue
  if (!Array.isArray(m.content)) continue
  messages.push({ role: m.role, content: m.content })
  if (m.role === 'assistant') {
    for (const b of m.content ?? []) {
      if (b?.type === 'reasoning' && typeof b.text === 'string') reasonings.push(b.text)
    }
  }
  if (messages.length >= 14) break
}

const header = events.find((e) => e.type === 'request/header')
const tools = header?.data?.header?.tools ?? []

const parts = serializePromptParts({ system, messages, tools, maxChars: 400_000 })
const prompt = parts.full

const count = (needle) => prompt.split(needle).length - 1
console.log(`会话 ${process.argv[2]}：取到 ${messages.length} 条消息、${reasonings.length} 段思考、工具定义 ${tools.length} 个`)
console.log(`拼出来的 prompt：${prompt.length} 字符；head（system+协议+工具目录）${parts.head.length} 字符`)
console.log('')
console.log('── 记忆类内容（模型每轮都会收到）──')
console.log(`  "User: "        出现 ${count('User: ')} 次`)
console.log(`  "Assistant: "   出现 ${count('Assistant: ')} 次`)
console.log(`  "[Tool Result"  出现 ${count('[Tool Result')} 次`)
console.log('')
console.log('── 模型自己上一轮的「思考」有没有被回传 ──')
let hit = 0
for (const [i, r] of reasonings.entries()) {
  const probe = r.replace(/\s+/g, ' ').trim().slice(0, 40)
  const inside = probe.length > 10 && prompt.includes(probe)
  if (inside) hit += 1
  console.log(`  第 ${i + 1} 段思考前 40 字：${probe.slice(0, 36)}…  → 在 prompt 里？${inside ? '❌ 在' : '✅ 不在'}`)
}
console.log('')
console.log(`小结：${reasonings.length} 段思考里，有 ${hit} 段被回传。`)
console.log('')
console.log('── prompt 里 tool-call 那行长什么样（证明"模型答应过什么"确实在里面）──')
for (const line of prompt.split('\n')) {
  if (line.startsWith('Assistant:')) {
    console.log('  ' + line.slice(0, 150))
    break
  }
}
