/**
 * 回归：凭证被服务端作废（AUTH）之后，**能不能自己换个号接着跑**（0.6.8）
 *
 * 现场（2026-09-30，用户截图 + 插件台账原文）：
 *   15:49:43  acc_de90f63b → {ok:false, code:"AUTH", ms:7}   ← 7ms＝本地拦截，请求没发出去
 *   15:49:45  同账号会话标题 → AUTH
 *   ⇒ 界面「本轮运行失败 · API 密钥无效」，用户**只能手动切号**才继续得了。
 *
 * 两个根因，本文件各守一半：
 *
 *   ① 新环境 `gate.json` 不存在 ⇒ `autoSwitchMinutes` 落回默认 **0（关闭）**
 *      ⇒ 整条自动换号链不工作。这条**是数据不是代码**，守不了；但判据守得住：
 *      「关着」**必须**回答"不能换号"（否则默认关闭的用户会被偷偷换号，是另一个 P0）。
 *
 *   ② `retryableCodes` 里没有 `AUTH` ⇒ dsh-llm-retry 一次都不重试
 *      ⇒ 换号检查点在**请求前**，没有下一次请求就永远等不到它。
 *      ⇒ 所以本文件最要紧的两条是：AUTH **必须**在里面，且
 *      **没得换号时给的退避必须 > maxDelayMs** —— 那才是"不能换号就不重试"的唯一实现方式
 *      （判据：要的延迟 > maxDelayMs 且 normal ⇒ 直接放弃重试）。
 *      ⚠️ 这两条是**成对**的：只把 AUTH 加进数组、忘了给大退避 ⇒ 死号上白打 5 次请求；
 *      只给大退避、忘了加进数组 ⇒ 那条 5s 的短退避永远走不到。改动一边必然弄红另一边。
 *
 * 用法: node tests/check-auth-failover.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { RETRY_POLICY } from '../src/adapter.ts'
import { AUTH_FAILOVER_RETRY_MS, AUTH_GIVEUP_RETRY_MS } from '../src/webapi.ts'
import { hasFailoverCandidate } from '../src/auto-switch.ts'

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error?.message ?? error}`)
    console.log(`  ✗ ${name}`)
  }
}

const USABLE = (id) => ({ id })
const DEAD = (id) => ({ id, lastVerifyError: { at: '2026-09-30T07:00:00.000Z', message: 'Authorization Failed' } })

// ── ① 重试策略：AUTH 要在里面，且两档退避跨在 maxDelayMs 的两侧 ───────────────
test('重试策略里包含 AUTH（否则那条 5s 短退避永远用不上）', () => {
  assert.ok(
    RETRY_POLICY.retryableCodes.includes('AUTH'),
    `retryableCodes 必须含 AUTH，实际=${JSON.stringify(RETRY_POLICY.retryableCodes)}`,
  )
})

test('能换号时给的退避 ≤ maxDelayMs（保证真的会被重试）', () => {
  assert.ok(
    AUTH_FAILOVER_RETRY_MS > 0 && AUTH_FAILOVER_RETRY_MS <= RETRY_POLICY.maxDelayMs,
    `AUTH_FAILOVER_RETRY_MS=${AUTH_FAILOVER_RETRY_MS} 必须满足 0 < x ≤ maxDelayMs=${RETRY_POLICY.maxDelayMs}`,
  )
})

test('没法换号时给的退避 > maxDelayMs（这才是"不重试"的实现方式）', () => {
  assert.ok(
    AUTH_GIVEUP_RETRY_MS > RETRY_POLICY.maxDelayMs,
    `AUTH_GIVEUP_RETRY_MS=${AUTH_GIVEUP_RETRY_MS} 必须 > maxDelayMs=${RETRY_POLICY.maxDelayMs}` +
      '（否则死号上会白打 5 次请求）',
  )
})

test('换号那档比"立刻重发"慢一点：留出 AUTH 复核探活的时间', () => {
  // 现场实测那次复核探活 0.9~3.5s。太短 ⇒ 检查点还没看到失效标记 ⇒ 又拿同一个死号发一次。
  assert.ok(AUTH_FAILOVER_RETRY_MS >= 3_000, `AUTH_FAILOVER_RETRY_MS=${AUTH_FAILOVER_RETRY_MS} 应 ≥ 3000`)
})

// ── ② 纯判据：三种边界的答案 ───────────────────────────────────────────────
const base = { switching: false, currentId: 'A', now: 1_000_000 }

test('自动换号关着 ⇒ 不能换号（默认关闭的用户不许被偷偷换走）', () => {
  assert.equal(hasFailoverCandidate({ ...base, minutes: 0, accounts: [USABLE('A'), USABLE('B')] }), false)
  assert.equal(
    hasFailoverCandidate({ ...base, minutes: Number.NaN, accounts: [USABLE('A'), USABLE('B')] }),
    false,
  )
})

test('开着且另有可用账号 ⇒ 能换号', () => {
  assert.equal(hasFailoverCandidate({ ...base, minutes: 30, accounts: [USABLE('A'), USABLE('B')] }), true)
})

test('当前账号已被判失效（AUTH 拦截那条路径）⇒ 仍能换到另一个可用号', () => {
  assert.equal(hasFailoverCandidate({ ...base, minutes: 30, accounts: [DEAD('A'), USABLE('B')] }), true)
})

test('候选里没有**别的**可用账号 ⇒ 不能换号（切了还是自己）', () => {
  assert.equal(hasFailoverCandidate({ ...base, minutes: 30, accounts: [USABLE('A')] }), false)
  assert.equal(hasFailoverCandidate({ ...base, minutes: 30, accounts: [USABLE('A'), DEAD('B')] }), false)
})

test('正在切换中 ⇒ 不叠加', () => {
  assert.equal(
    hasFailoverCandidate({ ...base, minutes: 30, switching: true, accounts: [USABLE('A'), USABLE('B')] }),
    false,
  )
})

test('被排除的账号不算候选（刚被限流的号切过去也是白搭）', () => {
  assert.equal(
    hasFailoverCandidate({
      ...base,
      minutes: 30,
      accounts: [USABLE('A'), USABLE('B')],
      excludeIds: new Set(['B']),
    }),
    false,
  )
})

// ── ③ 接线守卫：三个 AUTH 抛出点都得接上这条判据 ─────────────────────────────
// 「宿主真的调用了它」——判据写好了没人调，这个项目已经犯过两次（0.1.80 的拦截图谱、
// 0.6.6 的 errorKind）。这里按**抛出处**逐个数，避免"改了一处就当全接上了"。
const webapiSrc = readFileSync(new URL('../src/webapi.ts', import.meta.url), 'utf8')
const adapterSrc = readFileSync(new URL('../src/adapter.ts', import.meta.url), 'utf8')
const indexSrc = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

function countOf(haystack, needle) {
  return haystack.split(needle).length - 1
}

test('webapi 的两条 AUTH 路径（HTTP 401/403、信封 40003/40001）都问了 canFailover(\'auth\')', () => {
  const n = countOf(webapiSrc, "canFailover('auth')")
  assert.ok(n >= 2, `webapi.ts 里 canFailover('auth') 出现 ${n} 次，应 ≥ 2（HTTP 那条 + 信封那条）`)
})

test('adapter 的"已知失效、请求不发"那条也问了（否则界面在死号上静默重发）', () => {
  const n = countOf(adapterSrc, "canFailover?.('auth')")
  assert.ok(n >= 1, `adapter.ts 里 canFailover?.('auth') 出现 ${n} 次，应 ≥ 1`)
})

test('三个抛出点都带了条件式退避（都引用了两档常量）', () => {
  for (const [name, src] of [
    ['adapter.ts', adapterSrc],
    ['webapi.ts', webapiSrc],
  ]) {
    assert.ok(src.includes('AUTH_FAILOVER_RETRY_MS'), `${name} 必须引用 AUTH_FAILOVER_RETRY_MS`)
    assert.ok(src.includes('AUTH_GIVEUP_RETRY_MS'), `${name} 必须引用 AUTH_GIVEUP_RETRY_MS`)
  }
})

test('宿主 canFailover 的 kind 含 auth，且真的走 hasFailoverCandidate 这条判据', () => {
  assert.ok(
    /canFailover\s*=\s*\(\s*kind\?:\s*'muted'\s*\|\s*'throttled'\s*\|\s*'auth'/.test(indexSrc),
    'index.ts 的 canFailover 签名必须接受 auth',
  )
  assert.ok(indexSrc.includes('hasFailoverCandidate('), 'index.ts 必须用 hasFailoverCandidate 做判断')
  assert.ok(
    /if \(kind === 'throttled'/.test(indexSrc),
    'throttled 的窗口/冷却判据不能被删掉（auth 只是**不过**它，不是删掉它）',
  )
})

console.log(`\n[auth-failover] ${passed}/${passed + failures.length} 通过`)
if (failures.length > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log(`  - ${item}`)
  process.exit(1)
}
