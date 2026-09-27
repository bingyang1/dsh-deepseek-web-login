// 「自动换号」的回归用例。
//
// 这条链路还是四段式（**界面 → 路由 → gate.json → 宿主钩子**），所以落盘那几条断言照
// check-context-window.mjs 的规矩：**真 POST 一次 /gate，再读回 gate.json** ——
// 0.1.82 的 P0-1（maxRefImages 发不进去）就是死在路由白名单，而当时只有字符串断言在"守"。
//
// 挑选/决策那部分（auto-switch.ts）刻意做成纯函数，于是能直接喂字面量测边界：
// 失效的、受限未解除的、当前账号不可用的、可用不足两个的 …… 这些分支用真实账号库很难摆出来。
//
// ⚠️ 宿主钩子（maybeAutoSwitch 里探活 + setActiveAccount）**没有**在这里端到端跑：
// 它要真网络探活。这里守的是"决策对不对"与"设置存不存得进去"，
// 钩子与 adapter 的接线由产物断言 + 真机验证覆盖。

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dswl-autoswitch-'))
process.env.DSH_HOME = HOME

const {
  decideAutoSwitch,
  freshThrottledIds,
  isSwitchDue,
  isThrottleSwitchAllowed,
  pickNextAccount,
  THROTTLE_SWITCH_COOLDOWN_MS,
  THROTTLE_SWITCH_WINDOW_MS,
} = await import('../src/auto-switch.ts')
const { AUTO_SWITCH_BOUNDS, DEFAULT_AUTO_SWITCH_MINUTES, clampAutoSwitchMinutes } = await import(
  '../src/gate.ts'
)

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

const MIN = 60_000
const NOW = 1_700_000_000_000

/** 一个"可用"的账号（不回退失效标记、不受限）。 */
const ok = (id) => ({ id })

// ── 纯逻辑：到点判定 ─────────────────────────────────────────────────

await test('关闭（0）时永远不到点', () => {
  assert.equal(isSwitchDue(0, NOW - 999 * MIN, NOW), false)
  assert.equal(isSwitchDue(-3, NOW - 999 * MIN, NOW), false)
  assert.equal(isSwitchDue(Number.NaN, NOW - 999 * MIN, NOW), false)
})

await test('到点判定看的是"距上次切换过了多久"', () => {
  assert.equal(isSwitchDue(30, NOW - 29 * MIN, NOW), false, '差一分钟不算到点')
  assert.equal(isSwitchDue(30, NOW - 30 * MIN, NOW), true, '正好到点就算')
  assert.equal(isSwitchDue(30, NOW - 31 * MIN, NOW), true)
})

await test('没有起点时不切（宁可不动，也不要在"不知道用了多久"时换号）', () => {
  assert.equal(isSwitchDue(30, 0, NOW), false)
  assert.equal(isSwitchDue(30, Number.NaN, NOW), false)
})

// ── 纯逻辑：挑下一个 ─────────────────────────────────────────────────

await test('取"当前账号之后的下一个"，走到末尾绕回开头', () => {
  const accounts = [ok('a'), ok('b'), ok('c')]
  assert.equal(pickNextAccount(accounts, 'a', NOW), 'b')
  assert.equal(pickNextAccount(accounts, 'b', NOW), 'c')
  assert.equal(pickNextAccount(accounts, 'c', NOW), 'a', '末尾要绕回，否则最后一个账号之后就没得切了')
})

await test('跳过登录态失效的账号', () => {
  const accounts = [ok('a'), { id: 'b', lastVerifyError: { at: '2026-09-26T00:00:00.000Z', message: '401' } }, ok('c')]
  assert.equal(pickNextAccount(accounts, 'a', NOW), 'c', '切到 b 必然失败 —— 白折腾一轮全量重发')
})

await test('跳过受限还没解除的账号', () => {
  const accounts = [
    ok('a'),
    { id: 'b', limit: { untilMs: NOW + 60 * MIN, observedAt: '2026-09-26T00:00:00.000Z' } },
    ok('c'),
  ]
  assert.equal(pickNextAccount(accounts, 'a', NOW), 'c')
})

await test('受限时间已过 ⇒ 又是可用账号了', () => {
  const accounts = [
    ok('a'),
    { id: 'b', limit: { untilMs: NOW - 1, observedAt: '2026-09-26T00:00:00.000Z' } },
  ]
  assert.equal(pickNextAccount(accounts, 'a', NOW), 'b')
})

await test('当前账号自己不可用 ⇒ 取第一个可用的（救急路径）', () => {
  const accounts = [ok('a'), ok('b'), ok('c')]
  assert.equal(pickNextAccount(accounts, 'zzz', NOW), 'a', '当前账号不在库里/不在可用集合里')
  assert.equal(pickNextAccount(accounts, undefined, NOW), 'a')
})

await test('可用的不足两个 ⇒ 不切（切了还是它，没意义）', () => {
  assert.equal(pickNextAccount([ok('a')], 'a', NOW), undefined)
  assert.equal(
    pickNextAccount([ok('a'), { id: 'b', lastVerifyError: { at: 'x', message: 'y' } }], 'a', NOW),
    undefined,
    '另一个失效了就只剩自己',
  )
  assert.equal(pickNextAccount([], 'a', NOW), undefined)
})

// ── 纯逻辑：合成决策 ─────────────────────────────────────────────────

await test('decideAutoSwitch：关闭 / 未到点 / 到点 三种主路径', () => {
  const accounts = [ok('a'), ok('b')]
  assert.deepEqual(
    decideAutoSwitch({ minutes: 0, lastSwitchAt: NOW, now: NOW, accounts, currentId: 'a' }),
    { action: 'skip', reason: 'off' },
  )
  assert.deepEqual(
    decideAutoSwitch({ minutes: 30, lastSwitchAt: NOW - 5 * MIN, now: NOW, accounts, currentId: 'a' }),
    { action: 'skip', reason: 'not-due' },
  )
  assert.deepEqual(
    decideAutoSwitch({ minutes: 30, lastSwitchAt: NOW - 31 * MIN, now: NOW, accounts, currentId: 'a' }),
    { action: 'switch', nextId: 'b', reason: 'due' },
  )
})

await test('decideAutoSwitch：当前账号不可用 ⇒ 无视时间直接切走', () => {
  // 让用户在一个失效的账号上继续等满 30 分钟毫无意义 —— 那期间每个请求都会失败。
  const accounts = [{ id: 'a', lastVerifyError: { at: 'x', message: '401' } }, ok('b'), ok('c')]
  const decision = decideAutoSwitch({ minutes: 30, lastSwitchAt: NOW, now: NOW, accounts, currentId: 'a' })
  assert.equal(decision.action, 'switch')
  assert.equal(decision.reason, 'current-unusable', '理由要能区分"到点了"与"原账号坏了"')
  assert.equal(decision.nextId, 'b')
  // 对照：同一个库、同样"刚切过"的起点，当前账号若是好的就不会切
  assert.deepEqual(
    decideAutoSwitch({ minutes: 30, lastSwitchAt: NOW, now: NOW, accounts, currentId: 'b' }),
    { action: 'skip', reason: 'not-due' },
  )
})

await test('decideAutoSwitch：没候选时如实说清是哪种没候选', () => {
  const allBad = [{ id: 'a', lastVerifyError: { at: 'x', message: 'y' } }]
  assert.deepEqual(
    decideAutoSwitch({ minutes: 30, lastSwitchAt: NOW - 60 * MIN, now: NOW, accounts: allBad, currentId: 'a' }),
    { action: 'skip', reason: 'no-candidate' },
  )
  assert.deepEqual(
    decideAutoSwitch({ minutes: 30, lastSwitchAt: NOW - 60 * MIN, now: NOW, accounts: [ok('a')], currentId: 'a' }),
    { action: 'skip', reason: 'no-other-account' },
  )
})

// ── 落盘：真 POST 路由，再读回 gate.json ──────────────────────────────

async function boot() {
  const { apply } = await import('../src/index.ts')
  let handler
  const ctx = {
    effect: (fn) => fn(),
    llm: { registerAdapter() {}, listProviders: () => [] },
    webServer: { register: (opts) => { handler = opts.handler } },
    get: () => undefined,
  }
  apply(ctx, { probeIntervalMs: 0 })
  assert.equal(typeof handler, 'function', '自证：拿到了 HTTP handler')
  return handler
}

function fakeRes() {
  const res = {
    statusCode: 0,
    body: '',
    writeHead(status) { res.statusCode = status },
    end(text) { res.body = text ?? '' },
  }
  return res
}

// ⚠️ 两个踩过的坑（照抄，免得重犯）：
//  1) 路由挂在 `/deepseek-web-login/api` 前缀下 —— 少前缀一律 404，而 404 与"断言写错"长得一样；
//  2) `readJsonBody` 会调 `req.off(...)`，假 req 必须是**真 EventEmitter**，
//     否则 cleanup 抛在 promise 里 ⇒ promise 永不结算（表现为用例挂在 await 上）。
const API = '/deepseek-web-login/api'
const handler = await boot()

function fakeReq(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

async function post(route, payload) {
  const res = fakeRes()
  await handler(fakeReq('POST', API + route, payload), res)
  return { status: res.statusCode, data: res.body ? JSON.parse(res.body) : undefined }
}

async function get(route) {
  const res = fakeRes()
  await handler(fakeReq('GET', API + route), res)
  return { status: res.statusCode, data: res.body ? JSON.parse(res.body) : undefined }
}

const gateFile = join(HOME, 'web-login', 'gate.json')

await test('POST /gate {autoSwitchMinutes} 被接受并写进 gate.json', async () => {
  const { status, data } = await post('/gate', { autoSwitchMinutes: 30 })
  assert.equal(
    status,
    200,
    `漏了白名单会必然 400「没有可更新的字段」，实际 status=${status} body=${JSON.stringify(data)}`,
  )
  assert.equal(data?.autoSwitchMinutes, 30, '响应里要回显生效后的值')
  const persisted = JSON.parse(readFileSync(gateFile, 'utf8'))
  assert.equal(persisted.autoSwitchMinutes, 30, '**落盘**才是这条用例的重点')
})

await test('越界被夹到 0~120（含 0 = 关闭）', async () => {
  const high = await post('/gate', { autoSwitchMinutes: 9_999 })
  assert.equal(high.status, 200)
  assert.equal(high.data?.autoSwitchMinutes, AUTO_SWITCH_BOUNDS.max)
  const low = await post('/gate', { autoSwitchMinutes: -5 })
  assert.equal(low.data?.autoSwitchMinutes, AUTO_SWITCH_BOUNDS.min, '0 是合法值（关闭），别被当成非法')
})

await test('非数字仍然 400（白名单没变成"什么都收"）', async () => {
  const { status } = await post('/gate', { autoSwitchMinutes: 'abc' })
  assert.equal(status, 400)
})

await test('GET /gate 把边界与默认值给到界面（免得两边各写一套数字）', async () => {
  const { status, data } = await get('/gate')
  assert.equal(status, 200)
  assert.deepEqual(data?.autoSwitchBounds, { ...AUTO_SWITCH_BOUNDS }, '边界必须由后端给')
  assert.equal(data?.autoSwitchDefault, DEFAULT_AUTO_SWITCH_MINUTES, '默认必须是关闭（不动它的人行为不变）')
})

await test('GET /gate 带出「上次自动换号」（初始 null；界面靠它决定显不显示那一行）', async () => {
  const { status, data } = await get('/gate')
  assert.equal(status, 200)
  assert.ok(
    'lastAutoSwitch' in data,
    '字段必须**存在**于响应里 —— 缺了的话界面永远不显示"上次换号"，而且没人会发现',
  )
  assert.equal(
    data.lastAutoSwitch,
    null,
    '还没换过号时必须是 null 而不是 undefined —— JSON.stringify 会把 undefined 的键整个丢掉，' +
      '那就等于字段不存在（这条正是上面那句要防的）',
  )
})

await test('clamp 与默认值自洽：0 是关闭而不是被兜成默认', () => {
  assert.equal(clampAutoSwitchMinutes(0), 0)
  assert.equal(clampAutoSwitchMinutes(Number.NaN), DEFAULT_AUTO_SWITCH_MINUTES)
  assert.equal(DEFAULT_AUTO_SWITCH_MINUTES, 0, '默认关闭 —— 否则老用户升级后会被悄悄换号')
})

// ── 限流：第三条切号路径（0.5.2）─────────────────────────────────────
//
// 语义：限流是**瞬时**状态（不像封禁会写进账号记录的 `limit`），所以单独用"限流时刻表"判。
// 两条约束缺一不可：① 在窗口内（刚被限流）② 冷却已过（距上次换号够久）——
// 少了②，"每个号都被限流"就会一路换下去，那正是最该避免的形态。

await test('刚被限流 + 冷却已过 ⇒ 换号，理由是 recently-throttled', () => {
  const decision = decideAutoSwitch({
    minutes: 20,
    lastSwitchAt: NOW - 10 * MIN, // 10 分钟前换过 ⇒ 冷却（3 分钟）已过
    lastSwitchedAt: NOW - 10 * MIN,
    now: NOW,
    accounts: [ok('a'), ok('b')],
    currentId: 'a',
    throttledAt: new Map([['a', NOW - 5_000]]), // 5 秒前刚被限流
  })
  assert.deepEqual(decision, { action: 'switch', nextId: 'b', reason: 'recently-throttled' })
})

await test('🔴 冷却期内不换 —— 防的是"每个号都被限流时一路换下去"', () => {
  const decision = decideAutoSwitch({
    minutes: 20,
    lastSwitchAt: NOW - 30_000, // 30 秒前刚换过 ⇒ 冷却没过
    lastSwitchedAt: NOW - 30_000,
    now: NOW,
    accounts: [ok('a'), ok('b'), ok('c')],
    currentId: 'a',
    throttledAt: new Map([['a', NOW - 5_000]]),
  })
  assert.equal(decision.action, 'skip', '冷却期内必须忍住 —— 否则 9 个号会在几分钟内被轮一遍')
  assert.equal(decision.reason, 'not-due')
})

await test('限流发生在窗口之外（很久以前）⇒ 这一条不成立（到点归到点，别混为一谈）', () => {
  const decision = decideAutoSwitch({
    minutes: 20,
    lastSwitchAt: NOW - 15 * MIN, // 未到点（20 分钟），但已过冷却（3 分钟）
    now: NOW,
    accounts: [ok('a'), ok('b')],
    currentId: 'a',
    throttledAt: new Map([['a', NOW - 10 * MIN]]), // 远超窗口
  })
  assert.equal(decision.action, 'skip', '窗口外的限流不该成为换号理由 —— 那时多半早恢复了')
  assert.equal(decision.reason, 'not-due')
})

await test('不传限流时刻表 ⇒ 行为与从前完全一致（不会因限流换号）', () => {
  const base = {
    minutes: 20,
    lastSwitchAt: NOW - 5 * MIN,
    now: NOW,
    accounts: [ok('a'), ok('b')],
    currentId: 'a',
  }
  assert.equal(decideAutoSwitch(base).action, 'skip')
  assert.equal(decideAutoSwitch({ ...base, throttledAt: new Map() }).action, 'skip')
})

await test('🔴 排除项：切号时跳过"同样刚被限流的号"（切过去只会白搭一轮全量重发）', () => {
  const decision = decideAutoSwitch({
    minutes: 20,
    lastSwitchAt: NOW - 10 * MIN,
    lastSwitchedAt: NOW - 10 * MIN,
    now: NOW,
    accounts: [ok('a'), ok('b'), ok('c')],
    currentId: 'a',
    throttledAt: new Map([
      ['a', NOW - 5_000],
      ['b', NOW - 3_000], // b 也刚被限流过 ⇒ 不该切到 b
    ]),
  })
  assert.deepEqual(decision, { action: 'switch', nextId: 'c', reason: 'recently-throttled' })
})

await test('所有候选都刚被限流 ⇒ 不换（换谁都发不出去）', () => {
  const decision = decideAutoSwitch({
    minutes: 20,
    lastSwitchAt: NOW - 10 * MIN,
    lastSwitchedAt: NOW - 10 * MIN,
    now: NOW,
    accounts: [ok('a'), ok('b')],
    currentId: 'a',
    throttledAt: new Map([
      ['a', NOW - 1_000],
      ['b', NOW - 1_000],
    ]),
  })
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'no-candidate')
})

await test('限流与"到点"同时成立时，理由取更具体的那个（recently-throttled）', () => {
  const decision = decideAutoSwitch({
    minutes: 20,
    lastSwitchAt: NOW - 30 * MIN, // 也到点了
    now: NOW,
    accounts: [ok('a'), ok('b')],
    currentId: 'a',
    throttledAt: new Map([['a', NOW - 1_000]]),
  })
  assert.equal(decision.reason, 'recently-throttled')
})

await test('"当前账号不可用"的优先级仍高于限流（失效 / 封禁优先切走）', () => {
  const decision = decideAutoSwitch({
    minutes: 20,
    lastSwitchAt: NOW - 30_000, // 冷却期内
    now: NOW,
    accounts: [{ id: 'a', lastVerifyError: { at: 'x', message: '401' } }, ok('b')],
    currentId: 'a',
    throttledAt: new Map([['a', NOW - 1_000]]),
  })
  assert.deepEqual(decision, { action: 'switch', nextId: 'b', reason: 'current-unusable' })
})

await test('isThrottleSwitchAllowed：窗口 / 冷却 / 缺值三条边界', () => {
  const last = NOW - 10 * MIN
  assert.equal(isThrottleSwitchAllowed({ throttledAt: NOW, lastSwitchAt: last, now: NOW }), true)
  assert.equal(isThrottleSwitchAllowed({ throttledAt: 0, lastSwitchAt: last, now: NOW }), false, '0 = 没被限流过')
  assert.equal(isThrottleSwitchAllowed({ throttledAt: undefined, lastSwitchAt: last, now: NOW }), false)
  assert.equal(
    isThrottleSwitchAllowed({ throttledAt: NOW - THROTTLE_SWITCH_WINDOW_MS - 1, lastSwitchAt: last, now: NOW }),
    false,
    '窗口外',
  )
  assert.equal(
    isThrottleSwitchAllowed({ throttledAt: NOW, lastSwitchAt: NOW - THROTTLE_SWITCH_COOLDOWN_MS + 1, now: NOW }),
    false,
    '冷却未过',
  )
  assert.equal(
    isThrottleSwitchAllowed({ throttledAt: NOW, lastSwitchAt: NOW - THROTTLE_SWITCH_COOLDOWN_MS, now: NOW }),
    true,
    '冷却正好到点就算过',
  )
})

await test('🔴 本次启动还没换过号（lastSwitchedAt=0）⇒ 限流立刻可换', () => {
  // 2026-09-27 的真实现场：插件 10:56:30 启动、10:57:54 撞限流（距启动 73 秒）。
  // 当时的冷却拿 `lastSwitchAt`（= 启动时刻）算 ⇒ 73 秒 < 3 分钟 ⇒ 不换号，
  // 用户看到的是"依旧没有自动切换账号"。下面两条把那个 bug 钉死。
  const startedAt = NOW - 73_000
  const decision = decideAutoSwitch({
    minutes: 20,
    lastSwitchAt: startedAt, // due 用：距启动才 73 秒，远未到 20 分钟
    lastSwitchedAt: 0, // 本次没换过号 ⇒ 不套冷却
    now: NOW,
    accounts: [ok('a'), ok('b')],
    currentId: 'a',
    throttledAt: new Map([['a', NOW - 2_000]]),
  })
  assert.deepEqual(
    decision,
    { action: 'switch', nextId: 'b', reason: 'recently-throttled' },
    '没换过号时不该套冷却 —— 限流是明确的坏状态，值得立刻换走',
  )

  const buggy = decideAutoSwitch({
    minutes: 20,
    lastSwitchAt: startedAt,
    lastSwitchedAt: startedAt, // ← 旧写法：把"启动时刻"当成"上次换号"
    now: NOW,
    accounts: [ok('a'), ok('b')],
    currentId: 'a',
    throttledAt: new Map([['a', NOW - 2_000]]),
  })
  assert.equal(buggy.action, 'skip', '这条复现的就是那个 bug —— 重启后 3 分钟内的限流会被自己的冷却挡掉')
})

await test('🔴 宿主 canFailover 与决策必须同答（给了短退避却不换号＝更快地撞同一个限流）', () => {
  // 模拟真实时序：失败那一刻问 canFailover（拿"当下"当限流时刻），
  // 2 秒后重发时 maybeAutoSwitch 才拿到真正写入的限流时刻。
  // ⚠️ 两边都只能用"上次**真的换过号**"的时刻（`lastSwitchedAt`）算冷却。
  for (const sinceLastSwitch of [0, 30_000, 10 * MIN]) {
    const lastSwitchedAt = NOW - sinceLastSwitch
    const failoverSays = isThrottleSwitchAllowed({ throttledAt: NOW, lastSwitchAt: lastSwitchedAt, now: NOW })
    const decision = decideAutoSwitch({
      minutes: 20,
      lastSwitchAt: NOW - 15 * MIN, // due 刻意不成立（15 < 20 分钟），免得混进那条路径
      lastSwitchedAt,
      now: NOW + 2_000,
      accounts: [ok('a'), ok('b')],
      currentId: 'a',
      throttledAt: new Map([['a', NOW]]),
    })
    assert.equal(
      decision.action === 'switch',
      failoverSays,
      `距上次换号 ${sinceLastSwitch}ms 时两边给出了不同答案：canFailover=${failoverSays}，决策=${decision.action}`,
    )
  }
})

await test('freshThrottledIds：只留窗口内的', () => {
  const fresh = freshThrottledIds(
    new Map([
      ['a', NOW - 1_000],
      ['b', NOW - 10 * MIN],
      ['c', NOW - THROTTLE_SWITCH_WINDOW_MS - 1],
    ]),
    NOW,
  )
  assert.deepEqual([...fresh], ['a'])
  assert.equal(freshThrottledIds(undefined, NOW).size, 0)
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
