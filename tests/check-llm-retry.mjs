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

test('🔴 策略形状必须是「扁平」的：六个运行期字段齐全，且**没有** `backoff` 嵌套', () => {
  // 依据：dsh-llm 取策略是 `adapter.providerRetryPolicy(p) ?? resolveRetryPolicy(…)` ——
  // 我们一返回对象，右边那个"会把 backoff 展开成扁平"的规范化就**不会执行**，
  // 而 dsh-llm-retry 运行期读的是**扁平字段**（见它自己的 retryPolicyKey / localDelay）。
  assert.equal(policy.mode, 'normal', '只声明 normal：always 会无尝试上限地重试')
  assert.ok(Number.isSafeInteger(policy.maxRetries) && policy.maxRetries >= 1, `maxRetries 非法：${policy.maxRetries}`)
  assert.ok(Array.isArray(policy.retryableCodes) && policy.retryableCodes.length > 0, 'retryableCodes 不能为空')
  assert.equal(new Set(policy.retryableCodes).size, policy.retryableCodes.length, 'retryableCodes 不能有重复')

  const keys = Object.keys(policy).sort()
  assert.deepEqual(
    keys,
    ['initialDelayMs', 'jitterRatio', 'maxDelayMs', 'maxRetries', 'mode', 'retryableCodes'],
    `策略字段必须扁平且不多不少，实际：${keys.join(',')}（0.6.3 栽在 backoff 嵌套上，别改回去）`,
  )
  assert.ok(!('backoff' in policy), '不能有 backoff 嵌套 —— DSH 不会替我们展开，运行期读到的是 undefined')
})

test('🔴 回放 DSH 的 retryPolicyKey：后三项不许是 null（0.6.3 的实况就是三个 null）', () => {
  // dsh-llm-retry 原样是：
  //   JSON.stringify([policy.mode, policy.maxRetries, [...policy.retryableCodes].sort(),
  //                   policy.initialDelayMs, policy.maxDelayMs, policy.jitterRatio])
  // undefined 会被 stringify 成 null ⇒ 这正是"字段没生效"的指纹。
  const key = JSON.parse(
    JSON.stringify([
      policy.mode,
      policy.maxRetries,
      [...policy.retryableCodes].sort(),
      policy.initialDelayMs,
      policy.maxDelayMs,
      policy.jitterRatio,
    ]),
  )
  const tail = key.slice(3)
  assert.ok(
    tail.every((v) => typeof v === 'number' && Number.isFinite(v)),
    `policyKey 尾部三项必须是有限数（null 代表 undefined ⇒ 退避/上限全部失效），实际 ${JSON.stringify(tail)}`,
  )
})

test('🔴 回放 DSH 的 localDelay：不带 provider 延迟的失败也要算出**有限**退避', () => {
  // 0.6.3 实况：initialDelayMs/maxDelayMs 是 undefined ⇒ 这里算出 NaN ⇒ 写 `llm/retry` 事件时
  // DSH 拒收非有限数 ⇒ 整轮 UNKNOWN 死掉（用户以为是"模型自己停了"）。
  const localDelay = (config, retry, random) => {
    const exponent = Math.min(retry - 1, 1024)
    const exponential = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs)
    const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * random()
    return Math.min(exponential * jitter, config.maxDelayMs)
  }
  for (const retry of [1, 2, 3, 5]) {
    for (const r of [0, 0.5, 1]) {
      const ms = localDelay(policy, retry, () => r)
      assert.ok(
        Number.isFinite(ms) && ms > 0,
        `第 ${retry} 次重试的本地退避必须是有限正数（NaN 会让整轮报 UNKNOWN 死掉），实际 ${ms}`,
      )
      assert.ok(ms <= policy.maxDelayMs, `本地退避不能超过 maxDelayMs，实际 ${ms}`)
    }
  }
})

test('🔴 不变量：声明的 maxDelayMs ≥ 我们可能上报的最大退避', () => {
  assert.ok(
    policy.maxDelayMs >= MAX_THROTTLE_RETRY_MS,
    `maxDelayMs=${policy.maxDelayMs} 覆盖不了我们的最大退避 ${MAX_THROTTLE_RETRY_MS}（dsh-llm 会放弃重试）`,
  )
})

test('🔴 回放本次故障：实测的 49208ms 退避必须落在 maxDelayMs 之内', () => {
  // 取自 DSH 会话日志：failure.providerRetryAfterMs = 49208（throttleBackoffMs 首档 40s + 23% 抖动）
  const OBSERVED = 49_208
  assert.ok(
    !(OBSERVED > policy.maxDelayMs),
    `dsh-llm 的判据是「providerRetryAfterMs > maxDelayMs ⇒ 放弃重试」，${OBSERVED} vs ${policy.maxDelayMs}`,
  )
})

test('🔴 反向：超长解除时间（封禁一天）**必须**被判「等太久」而放弃（0.6.3 时这条判断失效了）', () => {
  // 0.6.3 因为 maxDelayMs=undefined，「X > undefined」恒为 false ⇒ 一天的封禁也会被照单等下去。
  const DAY = 24 * 60 * 60 * 1000
  assert.ok(DAY > policy.maxDelayMs, `一天的封禁必须超过上限（否则会空等一整天），实际 ${policy.maxDelayMs}`)
})

test('retryableCodes 必须含 RATE_LIMIT（否则我们最常见的失败根本不会被重试）', () => {
  assert.ok(policy.retryableCodes.includes('RATE_LIMIT'), `缺 RATE_LIMIT：${policy.retryableCodes.join(',')}`)
})

test('初始退避与「能换号」那条路同源（避免两处各写一个数字）', () => {
  assert.equal(policy.initialDelayMs, FAILOVER_RETRY_MS)
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
