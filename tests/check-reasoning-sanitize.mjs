/**
 * 回归（0.6.28）：**思考通道必须净化**。
 *
 * 背景（2026-10-02 用户实测）：网页端能看到 DSML 一类的工具调用标记。正文通道有四道网
 * （工具调用捕获 / 残片剥离 / 伪系统标记 / 免责声明 / 回声守卫），而思考通道此前
 * `if (event.kind === 'thinking') { …; continue }` **一道网都没有** —— 标记原样上屏，
 * 而且会进 DSH 历史 ⇒ 下一轮被当增量重发 ⇒ 变成网页端可见的正文垃圾，一直留着。
 *
 * 这组用例钉的是**意图**：
 *  ① 工具调用标记绝不出现在思考块里（这是用户报的现象）；
 *  ② 标记之外的思考内容**一个字都不能少**（净化 ≠ 截断）；
 *  ③ 跨包（标记被切成两半）也要挡住 —— 半截标记上屏是最难看的形态；
 *  ④ 正常讨论 XML 的思考**不许**被误剥（防过度净化）。
 *
 * 用法: node tests/check-reasoning-sanitize.mjs
 */
import assert from 'node:assert/strict'
import { createAdapter } from '../src/adapter.ts'

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

const AUTH = {
  token: 't'.repeat(64),
  cookie: '',
  hifDliq: '',
  hifLeim: '',
  wasmUrl: '',
  userAgent: 'test-ua',
  capturedAt: '2026-10-02T00:00:00.000Z',
}

/**
 * 跑一次真实入口，返回思考块/正文块的文本。
 * @param chunks 思考增量数组（模拟 SSE 分包）
 */
async function run(chunks, textChunks = []) {
  const adapter = createAdapter({
    getAuth: () => AUTH,
    config: { logger: undefined },
    streamCompletion: () =>
      (async function* () {
        for (const text of chunks) yield { kind: 'thinking', text }
        for (const text of textChunks) yield { kind: 'text', text }
        yield { kind: 'finish', reason: 'stop' }
      })(),
  })
  let reasoning = ''
  let body = ''
  for await (const event of adapter.stream({
    messages: [{ role: 'user', content: [{ type: 'text', text: '看一下' }] }],
  })) {
    if (event.type === 'reasoning-delta') reasoning += event.text
    if (event.type === 'block-end' && event.block?.type === 'reasoning') reasoning = event.block.text
    if (event.type === 'text-delta') body += event.text
  }
  return { reasoning, body }
}

/** 工具调用标记的几种现场形态（都是实测见过的）。 */
const MARKERS = [
  '<tool_calls>',
  '<invoke name=',
  '<parameter name=',
  'tool_calls',
  'DSML',
  '|DSML|',
  '<function_calls>',
  '{"tool_calls"',
]

function assertNoMarker(where, text) {
  for (const marker of MARKERS) {
    assert.ok(
      !text.includes(marker),
      `${where} 里不该出现工具调用标记 ${JSON.stringify(marker)}；实际内容：${JSON.stringify(text.slice(0, 200))}`,
    )
  }
}

// ── ① 完整 XML 调用块（跨多个增量）────────────────────────
await test('思考里的 XML 工具调用块不许上屏，块外的思考要保留', async () => {
  const { reasoning } = await run([
    '先确认一下这个文件。\n',
    '<tool_calls>\n',
    '<invoke name="read">\n',
    '<parameter name="file_path">src/a.ts</parameter>\n',
    '</invoke>\n',
    '</tool_calls>\n',
    '然后我就能决定下一步了。\n',
  ])
  assert.ok(reasoning.includes('先确认一下这个文件'), '块前的思考必须保留')
  assert.ok(reasoning.includes('然后我就能决定下一步了'), '块后的思考必须保留')
  assertNoMarker('思考块', reasoning)
})

// ── ② DSML 前缀（全角竖线，就是用户截图那种）──────────────
await test('思考里的 DSML 前缀调用块不许上屏', async () => {
  const { reasoning } = await run([
    '我需要读文件。\n',
    '<|DSML|calls>\n',
    '<|DSML|invoke name="bash">\n',
    '<|DSML|parameter name="command">ls</|DSML|parameter>\n',
    '</|DSML|invoke>\n',
    '</|DSML|calls>\n',
    '读完了。\n',
  ])
  assert.ok(reasoning.includes('我需要读文件'), '块前的思考必须保留')
  assert.ok(reasoning.includes('读完了'), '块后的思考必须保留')
  assertNoMarker('思考块', reasoning)
})

// ── ③ JSON 形态 ──────────────────────────────────────────
await test('思考里的 JSON 工具调用不许上屏', async () => {
  const { reasoning } = await run([
    '准备调用。\n',
    '{"tool_calls":[{"name":"read","arguments":{"file_path":"a.ts"}}]}',
    '\n调用完了。\n',
  ])
  assert.ok(reasoning.includes('准备调用'), '块前的思考必须保留')
  assert.ok(reasoning.includes('调用完了'), '块后的思考必须保留')
  assertNoMarker('思考块', reasoning)
})

// ── ④ 跨包半截标记：最难看的形态 ────────────────────────
await test('标记被切成两半（跨包）也不许漏出半截', async () => {
  // 逐字符喂 —— 任何跨包 hold-back 失效都会在半途把 `<` 或 `｜DSML` 吐出去
  const source = '看这里。\n<|DSML|calls><|DSML|invoke name="read"><|DSML|parameter name="file_path">a.ts</|DSML|parameter></|DSML|invoke></|DSML|calls>\n结束。\n'
  const { reasoning } = await run([...source])
  assert.ok(reasoning.includes('看这里'), '块前的思考必须保留')
  assert.ok(reasoning.includes('结束'), '块后的思考必须保留')
  assertNoMarker('思考块', reasoning)
  assert.ok(!reasoning.includes('<'), `思考块里不该残留任何左尖括号；实际：${JSON.stringify(reasoning)}`)
})

// ── ⑤ 退化残片（只有闭合标签，实测漏过正文）─────────────
await test('孤立的退化标记残片也要剥掉', async () => {
  const { reasoning } = await run(['我先想一下。\n</|DSML|calls>\n</|DSML|invoke>\n想完了。\n'])
  assert.ok(reasoning.includes('我先想一下'), '正常思考必须保留')
  assert.ok(reasoning.includes('想完了'), '正常思考必须保留')
  assertNoMarker('思考块', reasoning)
})

// ── ⑥ 反向守卫：正常思考不许被误剥 ──────────────────────
await test('★ 正常思考（含代码/尖括号讨论）一个字都不许少', async () => {
  const source =
    '用户问的是类型比较。\n' +
    '在 TypeScript 里 A < B 是泛型实参的写法，运行时不存在。\n' +
    '另外 `List<string>` 这种写法要小心。\n' +
    '所以结论是两者不能直接比较。\n'
  const { reasoning } = await run([source])
  assert.equal(reasoning, source, '正常思考被改动过 —— 净化器剥多了')
})

// ── ⑦ 长思考里夹一个调用块：前后都要在 ──────────────────
await test('长思考中间夹调用块：只少那一块', async () => {
  const { reasoning } = await run([
    '第一步：定位。\n',
    '第二步：读取。\n',
    '<tool_calls><invoke name="read"><parameter name="file_path">b.ts</parameter></invoke></tool_calls>',
    '第三步：改。\n',
    '第四步：验证。\n',
  ])
  for (const keep of ['第一步：定位', '第二步：读取', '第三步：改', '第四步：验证']) {
    assert.ok(reasoning.includes(keep), `思考少了 ${keep}`)
  }
  assertNoMarker('思考块', reasoning)
})

// ── ⑧ 正文通道不受影响（别把两件事搅在一起）─────────────
await test('思考被净化不影响正文通道的正常输出', async () => {
  const { reasoning, body } = await run(['想一下。\n'], ['这是正文。\n'])
  assert.equal(body, '这是正文。\n', '正文不该被思考通道的改动影响')
  assert.ok(reasoning.includes('想一下'), '思考内容必须保留')
})

console.log(
  failures.length === 0
    ? `\n通过 ${passed} 项，全部通过 ✅`
    : `\n通过 ${passed} 项，失败 ${failures.length} 项 ❌\n${failures.join('\n')}`,
)
if (failures.length > 0) process.exitCode = 1
