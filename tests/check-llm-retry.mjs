/**
 * 回归：交给 dsh-llm 的**重试策略**（0.6.3）
 *
 * 现场（2026-09-27 14:35:32，用户截图 + DSH 会话日志原文）：
 *   网页端节流 → 我们抛 {code:"RATE_LIMIT", providerRetryAfterMs:49208}
 *   → dsh-llm 的**默认**策略 maxDelayMs=10s，normal 模式下"提供方要的等太久"
 *     **直接放弃重试**（`return next()`）
 *   → `turn/end` 是 error，界面显示「本轮运行失败」，**必须用户手点「继续」**。
 *
 * 根因不是"退避算错了"，而是**我们没声明策略**（`providerRetryPolicy` 返回 undefined
 * ⇒ 落到默认的 10s 上限）。所以本文件守两件事：
 *
 *   ① 适配器**必须显式给出**策略；
 *   ② 不变量「**我们可能上报的最大退避 ≤ 声明的 maxDelayMs**」—— 只改一边就会复发。
 *      这条正是本次事故会命中的断言（49208 > 10000）。
 *
 * ⚠️ 注意 dsh-llm 的写法是 `adapter.providerRetryPolicy(provider) ?? resolveRetryPolicy(...)`：
 *    我们返回的对象会**原样使用、不经它校验**（`resolveRetryPolicy` 只在返回空值时兜底）
 *    ⇒ 形状必须自己守（见「策略形状合规」那条）。
 *
 * 用法: node tests/check-llm-retry.mjs
 */
import assert from 'node:assert/strict'
import { createAdapter, RETRY_POLICY } from '../src/adapter.ts'
import { FAILOVER_RETRY_MS, MAX_THROTTLE_RETRY_MS, throttleBackoffMs } from '../src/webapi.ts'

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

const AUTH = {
  token: 't',
  cookie: '',
  hifDliq: '',
  hifLeim: '',
  wasmUrl: '',
  userAgent: 'test-ua',
  capturedAt: '2026-09-11T00:00:00.000Z',
}

/** 走**真实入口**取策略（不是拿常量自证）—— dsh-llm 调的就是这个方法。 */
const adapter = createAdapter({ getAuth: () => AUTH, config: {} })
const policy = adapter.providerRetryPolicy('deepseek-web')

test('适配器给出了重试策略（返回 undefined = 退回 dsh-llm 的 10s 上限 = 本故障）', () => {
  assert.ok(policy && typeof policy === 'object', `providerRetryPolicy 必须给对象，实际 ${typeof policy}`)
})

test('策略形状合规（adapter 返回的策略不会被 dsh-llm 校验，只能自己守）', () => {
  assert.equal(policy.mode, 'normal', '只声明 normal：always 会无尝试上限地重试')
  assert.ok(Number.isSafeInteger(policy.maxRetries) && policy.maxRetries >= 1, `maxRetries 非法：${policy.maxRetries}`)
  const keys = Object.keys(policy).sort()
  assert.deepEqual(
    keys,
    ['backoff', 'maxRetries', 'mode', 'retryableCodes'],
    `未知键会被 dsh-llm 的 validateKeys 拒掉（那条只在它自己解析配置时才跑，我们这份不跑）：${keys.join(',')}`,
  )
  assert.ok(Array.isArray(policy.retryableCodes) && policy.retryableCodes.length > 0, 'retryableCodes 不能为空')
  assert.equal(new Set(policy.retryableCodes).size, policy.retryableCodes.length, 'retryableCodes 不能有重复')
  const backoffKeys = Object.keys(policy.backoff).sort()
  assert.deepEqual(backoffKeys, ['initialDelayMs', 'jitterRatio', 'maxDelayMs'], `backoff 键名不对：${backoffKeys.join(',')}`)
  assert.ok(policy.backoff.initialDelayMs > 0, 'initialDelayMs 必须为正')
  assert.ok(
    policy.backoff.initialDelayMs <= policy.backoff.maxDelayMs,
    'dsh-llm 要求 initialDelayMs ≤ maxDelayMs',
  )
  assert.ok(policy.backoff.jitterRatio >= 0 && policy.backoff.jitterRatio <= 1, 'jitterRatio 必须在 0~1')
})

test('🔴 不变量：声明的 maxDelayMs ≥ 我们可能上报的最大退避', () => {
  assert.ok(
    policy.backoff.maxDelayMs >= MAX_THROTTLE_RETRY_MS,
    `maxDelayMs=${policy.backoff.maxDelayMs} 覆盖不了我们的最大退避 ${MAX_THROTTLE_RETRY_MS}（dsh-llm 会放弃重试）`,
  )
})

test('🔴 回放本次故障：实测的 49208ms 退避必须落在 maxDelayMs 之内', () => {
  // 取自 DSH 会话日志：failure.providerRetryAfterMs = 49208（throttleBackoffMs 首档 40s + 23% 抖动）
  const OBSERVED = 49_208
  assert.ok(
    !(OBSERVED > policy.backoff.maxDelayMs),
    `dsh-llm 的判据是「providerRetryAfterMs > maxDelayMs ⇒ 放弃重试」，${OBSERVED} vs ${policy.backoff.maxDelayMs}`,
  )
})

test('retryableCodes 必须含 RATE_LIMIT（否则我们最常见的失败根本不会被重试）', () => {
  assert.ok(policy.retryableCodes.includes('RATE_LIMIT'), `缺 RATE_LIMIT：${policy.retryableCodes.join(',')}`)
})

test('初始退避与「能换号」那条路同源（避免两处各写一个数字）', () => {
  assert.equal(policy.backoff.initialDelayMs, FAILOVER_RETRY_MS)
})

test('throttleBackoffMs 首档 = 20s 基数 + 0~30% 抖动，且不超过声明的上限', () => {
  // ⚠️ 这个纯函数**不推进档位**（推档在 noteThrottled 里），所以这里只能测首档 ——
  //    首档值钉住「基数 20s、抖动 30%」这两个常量；升档（40s → 80s → 90s 封顶）由
  //    check-session-lifecycle 里连续两次限流的端到端用例守。
  let min = Infinity
  let max = 0
  for (let i = 0; i < 400; i += 1) {
    const value = throttleBackoffMs()
    min = Math.min(min, value)
    max = Math.max(max, value)
  }
  assert.ok(min >= 20_000, `首档不该低于基数 20s，抽到 ${min}`)
  assert.ok(max <= 26_000, `首档抖动上限 30% ⇒ 不超过 26s，抽到 ${max}`)
  assert.ok(max <= MAX_THROTTLE_RETRY_MS, `抽到 ${max}，超过声明上限 ${MAX_THROTTLE_RETRY_MS}`)
})

console.log('')
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项 ❌`)
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log(`通过 ${passed} 项，全部通过 ✅`)
