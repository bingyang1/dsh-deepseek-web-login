/**
 * A/B 实测：「思考里反复复述用户那句话」到底跟投喂模式有没有关系。
 *
 * 做法：**复用插件自己的 adapter**（真实协议序列化 + 真实网页端请求 + 真实工具调用协议），
 * 在上面套一个最小 agent loop（复刻 DSH 的循环：一次模型调用 → 执行工具 → 把结果作为
 * tool-result 回喂 → 再调一次）。同一道需要 4 次工具调用的任务，分别用
 * `full`（每轮重发全量、新建会话）与 `chained`（只发增量 + parent 指向上一轮）各跑一遍。
 *
 * 统计：模型调用次数、思考段数、思考总字符、用户任务独有短语在思考里的出现次数、
 * 每轮上报的输入/输出 token（插件自己估的，见 adapter 的 usage 事件）。
 *
 * ⚠️ 会打真实请求（这是唯一能测"模型行为"的方式）；用的是账号库里的**非当前活动号**，
 *    免得和正在运行的 DSH 抢同一个会话/账号。
 *
 * 用法: node ab-context-feed.mjs full|chained [最大步数]
 */
import { writeFileSync } from 'node:fs'
import { createAdapter } from '../src/adapter.ts'
import { createRequestGate } from '../src/gate.ts'
import { applyContextMode } from '../src/context-feed.ts'
import { listAccounts, activeAccountId } from '../src/accounts.ts'
import { setFetchImpl, validateAuth } from '../src/webapi.ts'

// 抓请求体：看这一轮到底发了多少 prompt 字符、`parent_message_id` 是不是有值。
// 🔴 只看 usage 的 token 估算是不够的 —— 那个数分不出"链真的接上了"和"每轮退回全量"。
//    `parent_message_id: null` ＝ 这条是根消息（全量）；有值 ＝ 真的挂在上一轮回答后面（链式）。
const sent = []
const realFetch = globalThis.fetch
setFetchImpl((input, init) => {
  try {
    const url = String(input?.url ?? input)
    if (url.includes('/chat/completion') && init?.body) {
      const body = JSON.parse(String(init.body))
      sent.push({
        promptChars: String(body.prompt ?? '').length,
        parent: body.parent_message_id ?? null,
        session: String(body.chat_session_id ?? ''),
      })
    }
  } catch {}
  return realFetch(input, init)
})

const MODE = process.argv[2] === 'chained' ? 'chained' : 'full'
const MAX_STEPS = Number(process.argv[3] ?? 6)

// ⚠️ 任务形态必须贴近"用户带着质疑、要排查"的真实场景 ——
// 第一版用了"读 4 个文件再拼起来"这种一目了然的活，两组思考都只有 16~56 字、
// 一句复述都没有，A/B 直接失去分辨力。现在照用户那次会话复刻：
// 用户对"装好了没"持怀疑 + 中途有失败（b.txt 不存在）⇒ 模型需要重新规划。
const TASK =
  '排查一下：用户说「你确定安装好了？？那为啥没有设置页面呢」。' +
  '请用 read_file 工具**逐个**读取 a.txt / b.txt / c.txt / d.txt 找线索（一次只读一个，不要并行），' +
  '四个都处理完之后，用一行给出你的结论。'
const NONCE = '你确定安装好了？？那为啥没有设置页面呢' // 用户的原话，复述就是复述它

const SYSTEM = '你是一个编码助手，可以用 read_file 工具读取文件。回答保持简短。'
const TOOLS = [
  {
    name: 'read_file',
    description: '读取一个文本文件的内容并返回。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '要读取的文件路径' } },
      required: ['path'],
    },
  },
]

const FILES = {
  'a.txt': '插件目录：~/.dsh/profiles/desktop/ 下能看到 dsh-deepseek-web-login。',
  // b.txt 刻意不存在 ⇒ 工具返回失败 ⇒ 逼模型重新规划（真实场景里就是"装上了但界面没出现"）
  'c.txt': 'cordis.yml 的 bundles 里有这一项。',
  'd.txt': '设置页的入口在「设置 → DeepSeek 网页登录」，需要重启后才会出现。',
}

function runTool(name, rawArgs) {
  if (name !== 'read_file') return `未知工具：${name}`
  let args = {}
  try {
    args = JSON.parse(rawArgs || '{}')
  } catch {
    return '参数不是合法 JSON'
  }
  const p = String(args.path ?? args.file_path ?? '').trim()
  const hit = Object.keys(FILES).find((k) => p.endsWith(k))
  return hit ? FILES[hit] : `文件不存在：${p || '(空)'}`
}

// 用**非活动账号**，避免和正在运行的 DSH 抢账号/会话。
// ⚠️ 必须**先探活**再选：只看"没被标记失效"会挑到已经死掉但还没被标记的号，
//    上一次就是这么白跑一次的（第一次请求直接被本地拦截，一步都没跑成）。
const accounts = listAccounts()
const active = activeAccountId()
const candidates = accounts.filter((a) => a.id !== active && !a.lastVerifyError)
let account
for (const cand of candidates) {
  const verdict = await validateAuth(cand, AbortSignal.timeout(20_000))
  console.log(`  候选 ${cand.id}: ${verdict.ok ? '✅ 可用' : '❌ ' + (verdict.error ?? '探活未通过')}`)
  if (verdict.ok) {
    account = cand
    break
  }
}
if (!account) {
  console.error('账号库里没有**活的**非活动账号（全部探活失败）—— 先登录一个号再跑')
  process.exit(2)
}
console.log(`模式=${MODE}  账号=${account.id}（活动号是 ${active}，刻意避开）  最大步数=${MAX_STEPS}`)

applyContextMode(MODE)

const adapter = createAdapter({
  getAuth: () => account,
  config: { logger: { info: () => {}, warn: (m) => console.log('  [warn] ' + m) } },
  gate: createRequestGate({ minRequestIntervalMs: 2_000, maxRequestIntervalMs: 4_000 }),
})

const messages = [{ role: 'user', content: [{ type: 'text', text: TASK }] }]
const steps = []

for (let step = 1; step <= MAX_STEPS; step += 1) {
  let reasoning = ''
  let text = ''
  const calls = []
  let usage
  const started = Date.now()
  const signal = AbortSignal.timeout(180_000)

  for await (const ev of adapter.stream({
    purpose: 'chat',
    model: 'deepseek-reasoner',
    system: SYSTEM,
    tools: TOOLS,
    messages,
    signal,
  })) {
    if (ev.type === 'reasoning-delta') reasoning += ev.text ?? ''
    else if (ev.type === 'text-delta') text += ev.text ?? ''
    else if (ev.type === 'block-end' && ev.block?.type === 'tool-call') calls.push(ev.block)
    else if (ev.type === 'block-end' && ev.block?.type === 'reasoning') reasoning = ev.block.text ?? reasoning
    else if (ev.type === 'usage') usage = ev.usage
  }

  steps.push({
    step,
    ms: Date.now() - started,
    reasoningChars: reasoning.length,
    nonceHits: reasoning.split(NONCE).length - 1,
    head: reasoning.replace(/\s+/g, ' ').slice(0, 140),
    calls: calls.map((c) => ({ name: c.name, args: c.arguments })),
    textChars: text.length,
    usage,
  })
  console.log(
    `  step ${step}: 思考 ${reasoning.length} 字 / 非ce ${reasoning.split(NONCE).length - 1} 次 / ` +
      `工具 ${calls.map((c) => c.name).join(',') || '（无）'} / ${Date.now() - started}ms`,
  )
  console.log(`     起手式: ${steps.at(-1).head.slice(0, 100)}`)

  if (calls.length === 0) break

  messages.push({
    role: 'assistant',
    content: calls.map((c) => ({ type: 'tool-call', id: c.id, name: c.name, arguments: c.arguments })),
  })
  messages.push({
    role: 'user',
    content: calls.map((c) => ({
      type: 'tool-result',
      toolCallId: c.id,
      content: [{ type: 'text', text: runTool(c.name, c.arguments) }],
    })),
  })
}

const reasoningTotal = steps.reduce((a, s) => a + s.reasoningChars, 0)
const nonceTotal = steps.reduce((a, s) => a + s.nonceHits, 0)
const inTokens = steps.reduce((a, s) => a + (s.usage?.inputTokens ?? 0), 0)
const outTokens = steps.reduce((a, s) => a + (s.usage?.outputTokens ?? 0), 0)

const summary = {
  mode: MODE,
  account: account.id,
  steps: steps.length,
  reasoningTotal,
  nonceTotal,
  nonceSegments: steps.filter((s) => s.nonceHits > 0).length,
  inTokens,
  outTokens,
  requests: sent,
  stepsDetail: steps,
}
const file = `ab-${MODE}-${Date.now()}.json`
writeFileSync(file, JSON.stringify(summary, null, 2))

console.log('\n每一轮真正发出去的请求体：')
sent.forEach((r, i) => {
  console.log(
    `  第 ${i + 1} 次: prompt ${String(r.promptChars).padStart(7)} 字符 | parent_message_id=${
      r.parent === null ? 'null（根消息＝全量）' : String(r.parent).slice(0, 12) + '（挂链）'
    }`,
  )
})
const chainHits = sent.filter((r) => r.parent !== null).length
console.log(`\n[${MODE}] 模型调用 ${steps.length} 次；思考段 ${steps.length} 段 / 共 ${reasoningTotal} 字；` +
  `「${NONCE.slice(0, 12)}…」出现 ${nonceTotal} 次（${summary.nonceSegments} 段里）；` +
  `输入 ${inTokens} tok / 输出 ${outTokens} tok；**真的挂上链的有 ${chainHits}/${sent.length} 次**`)
console.log(`明细: ${file}`)
