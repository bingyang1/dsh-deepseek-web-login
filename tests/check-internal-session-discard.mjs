/**
 * 回归：**内部请求的网页端会话不许留在用户的网页端里**。
 *
 * 现场（2026-10-02，用户原话）：
 *   「刚在 dsh 中新建一个窗口聊天，就发了一句话，网页版直接俩窗口」
 * `feed-decisions.jsonl` 里对上了：
 *   12:55:54 `new-session`（对话，`04c63135`）
 *   12:56:00 `no-parts`  （内部请求，`de6a8d4f`）← 网页端多出来的就是这个
 * 而且它**连 ledger 都没有** —— 用户选了 `sessionCleanup: keep`，而 `schedule()` 在 keep
 * 下直接 return ⇒ 从没安排过删除。
 *
 * 判据（与 `requestSlotKey` / adapter 的 `chatLike` 同一处）：**`promptParts` 有没有传**。
 * 不带 = 内部请求（`session-title` / 压缩）⇒ 它的会话是**脚手架**，用完必须丢，
 * 且**不受** `keep` / `manualOnly` 影响 —— 那两道只管**用户的对话**。
 *
 * 用法: node tests/check-internal-session-discard.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-discard-'))

const { streamWebCompletion, setFetchImpl, resetSessionReuse, createSessionCleaner, disposeSessionReuse } =
  await import('../src/webapi.ts')

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`  ✗ ${name}\n      ${error.message}`)
  }
}

const SSE_OK = 'data: {"v":{"response":{"content":"hi"}}}\n\ndata: [DONE]\n\n'
const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8' }
const okFetch = async () => new Response(SSE_OK, { status: 200, headers: SSE_HEADERS })
const AUTH = { token: 'token-A', cookie: 'c=A' }
/** 模拟真实 chat 请求的夹具：**必须带 `promptParts`**（见文件头）。 */
const CHAT_PARTS = { head: 'HEAD', entries: ['User: x'] }

/** 假 transport：记下建了哪些会话。 */
function mkTransport() {
  const created = []
  return {
    created,
    transport: {
      createSession: async () => {
        const id = `sess-${created.length + 1}`
        created.push(id)
        return id
      },
      powHeader: async () => 'pow',
    },
  }
}

/** 跑一轮，返回「被交给宿主删除的」与「被丢掉的脚手架」两本账。 */
async function runOnce({ transport, promptParts, onDiscardSession }) {
  const deleted = []
  const discarded = []
  setFetchImpl(okFetch)
  const params = {
    prompt: 'P',
    thinkingEnabled: false,
    modelType: 'default',
    idleTimeoutMs: 5_000,
    onDeleteSession: (id) => deleted.push(id),
    ...(promptParts !== undefined ? { promptParts } : {}),
    ...(onDiscardSession !== undefined ? { onDiscardSession } : {}),
  }
  for await (const _ of streamWebCompletion(AUTH, params, transport)) void _
  void discarded
  return { deleted, discarded }
}

console.log('内部请求的脚手架会话')

await test('★ 不带 promptParts（内部请求）⇒ 会话交给「丢掉」通道，**不**进用户的清理队列', async () => {
  resetSessionReuse()
  const { created, transport } = mkTransport()
  const discarded = []
  const deleted = []
  setFetchImpl(okFetch)
  for await (const _ of streamWebCompletion(AUTH, {
    prompt: 'Create a concise title…',
    thinkingEnabled: false,
    modelType: 'default',
    idleTimeoutMs: 5_000,
    onDeleteSession: (id) => deleted.push(id),
    onDiscardSession: (id) => discarded.push(id),
  }, transport)) {
    /* 只关心收尾 */
  }
  assert.equal(created.length, 1, '自证：它确实需要一条自己的会话')
  assert.deepEqual(discarded, ['sess-1'], '内部请求的会话必须走「丢掉」通道')
  assert.deepEqual(deleted, [], '它**不该**进用户的清理队列（keep 模式下那条是空操作 ⇒ 会话会留下）')
})

await test('★ 复用的内部会话也要丢（它不在 owned 里 —— 这正是漏掉它的地方）', async () => {
  resetSessionReuse()
  const { created, transport } = mkTransport()
  const discarded = []
  setFetchImpl(okFetch)
  const once = async () => {
    for await (const _ of streamWebCompletion(AUTH, {
      prompt: 'title',
      thinkingEnabled: false,
      modelType: 'default',
      idleTimeoutMs: 5_000,
      sessionReuseTurns: 20, // 允许复用 ⇒ 第二次会复用同一条
      onDiscardSession: (id) => discarded.push(id),
    }, transport)) {
      /* 只关心收尾 */
    }
  }
  await once()
  await once()
  assert.equal(created.length, 2, '丢掉之后槽被清 ⇒ 第二次应当另建一条（而不是复用那条已丢的）')
  assert.deepEqual(discarded, ['sess-1', 'sess-2'], `两次都必须丢，实际 ${JSON.stringify(discarded)}`)
})

await test('★ 对话请求（带 promptParts）⇒ 仍走原来的清理通道，不进「丢掉」通道', async () => {
  resetSessionReuse()
  const { created, transport } = mkTransport()
  const discarded = []
  const deleted = []
  setFetchImpl(okFetch)
  for await (const _ of streamWebCompletion(AUTH, {
    prompt: 'P',
    thinkingEnabled: false,
    modelType: 'default',
    idleTimeoutMs: 5_000,
    sessionReuseTurns: 0, // 用完即删 ⇒ 走 onDeleteSession
    promptParts: CHAT_PARTS,
    onDeleteSession: (id) => deleted.push(id),
    onDiscardSession: (id) => discarded.push(id),
  }, transport)) {
    /* 只关心收尾 */
  }
  assert.equal(created.length, 1)
  assert.deepEqual(discarded, [], '对话请求的会话**不是**脚手架，不该被强制丢掉')
  assert.deepEqual(deleted, ['sess-1'], '对话请求仍按用户的清理策略处理')
})

// ── 清理器：keep / manualOnly 都拦不住 discard ──────────────────────────────

/** 造一个清理器，记下它真的发了哪些删除请求。 */
function mkCleaner({ mode, manualOnly, batchSize = 10 }) {
  const del = []
  const cleaner = createSessionCleaner({
    // ⚠️ `batchSize` 必须够大、`delayMs` 必须够长：否则 `schedule()` 会**当场** flush，
    // 于是"队列里还留着用户的会话"这条根本测不到（第一版我用了 batchSize:1，就踩了这个）。
    // ⚠️ 也不要用 `flush()` 当"这个模式不会删"的自证 —— `flush()` 是**手动**立即清理，
    // 它的文档明确写着"手动调用不受 manualOnly 限制"。
    policy: { mode, delayMs: 600_000, batchSize, gapMs: 0 },
    ...(manualOnly !== undefined ? { manualOnly } : {}),
    fetchImpl: async (url, init) => {
      if (!String(url).includes('chat_session/delete')) throw new Error(`意外的请求：${url}`)
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (body.chat_session_id) del.push(body.chat_session_id)
      return new Response(JSON.stringify({ code: 0, msg: '', data: { biz_code: 0 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  return { cleaner, del }
}

for (const [label, opts] of [
  ['keep（用户选的「不删」）', { mode: 'keep' }],
  ['manualOnly（链式模式下攒着等手动清）', { mode: 'deferred', manualOnly: true }],
]) {
  await test(`★ ${label} ⇒ 脚手架会话仍然必须被删掉`, async () => {
    const { cleaner, del } = mkCleaner(opts)
    // 自证：这个模式对**普通会话**确实不会删（keep：不入队；manualOnly：入队但不自动清）
    cleaner.schedule(AUTH, 'user-session')
    assert.deepEqual(del, [], '自证：普通会话此刻不该被删')
    assert.equal(
      cleaner.pendingCount(),
      opts.mode === 'keep' ? 0 : 1,
      '自证：keep 连队都不入；manualOnly 入队但等着手动清',
    )

    await cleaner.discard(AUTH, 'scaffolding-session')
    assert.deepEqual(
      del,
      ['scaffolding-session'],
      `${label} 下脚手架会话必须被删掉，实际 ${JSON.stringify(del)}`,
    )
  })
}

await test('★ discard 只删自己那一个 —— 不许顺手把队列里用户的会话也删了', async () => {
  const { cleaner, del } = mkCleaner({ mode: 'deferred', manualOnly: true })
  cleaner.schedule(AUTH, 'user-session-1')
  cleaner.schedule(AUTH, 'user-session-2')
  assert.equal(cleaner.pendingCount(), 2, '自证：用户的会话确实在队列里等着')
  await cleaner.discard(AUTH, 'scaffolding-session')
  assert.deepEqual(
    del,
    ['scaffolding-session'],
    'manualOnly 下队列里攒的是**用户的**会话；借这次机会顺手删掉 = "用户没点按钮却被删了"',
  )
  assert.equal(cleaner.pendingCount(), 2, '用户的会话必须还在队列里等着')
})

// 复位，别把注入层留给别的测试
setFetchImpl()
resetSessionReuse()
disposeSessionReuse()

console.log()
console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const f of failures) console.log('  ' + f)
if (failures.length) process.exitCode = 1
