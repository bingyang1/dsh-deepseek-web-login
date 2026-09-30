/**
 * 回归：切换账号前那次探活的**分类处置**（0.6.7）
 *
 * 现场（2026-09-30 13:2x，用户截图）：点某个**正常**账号的「切换」，
 * 底部弹出一行红字 ——
 *   `切换失败：该账号登录态校验未通过（The operation was aborted due to timeout），请重新登录后再切换`
 * 而那时的"失败"只是**探活超时**（网络抖了一下），凭证完全可用。
 *
 * 根因：跳转前的探活**没有按失败类型分流** —— `probeOnce` 早就给出了 `errorKind`
 * （'auth' | 'transport'，0.6.6 引入），但 `/accounts/switch` 无视它，一律拦下并
 * 让用户"重新登录"。这与 `staleAuthRecord` 的取舍冲突：**网络问题不该冒充授权结论**。
 *
 * 本文件守三件事：
 *   ① `switchGateFromProbe` 的判据（真求值，不是正则匹配代码形状）；
 *   ② 交互路径的探活超时**短于**后台默认的 20s（按钮上等 20 秒＝"点了没反应"）；
 *   ③ 宿主**真的调用了**这个判据 —— 历史上出现过"判据写好了但没人调用"（0.1.80）。
 *
 * 用法: node tests/check-switch-gate.mjs
 *
 * ⚠️ 文件名里别带 "probe"：`scripts/test-files.mjs` 的 `isManualProbe()` 按
 * 「含 probe 即人工诊断脚本」排除 —— 这条宽规则**故意不放松**（防止真打网络的
 * `check-*-probe-live.mjs` 溜进 CI），所以本文件叫 `-gate` 而不是 `-probe`。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SWITCH_PROBE_TIMEOUT_MS, switchGateFromProbe } from '../src/probe.ts'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

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

const AUTH_FAIL = {
  ok: false,
  at: '2026-09-30T05:20:00.000Z',
  error: 'Authorization Failed (invalid token)',
  errorKind: 'auth',
}
const NET_FAIL = {
  ok: false,
  at: '2026-09-30T05:20:00.000Z',
  error: 'The operation was aborted due to timeout',
  errorKind: 'transport',
}
const OK = { ok: true, at: '2026-09-30T05:20:00.000Z' }

console.log('switchGateFromProbe —— 按失败类型决定拦不拦')

test('授权失效 ⇒ 拦下（relogin）', () => {
  assert.equal(switchGateFromProbe(AUTH_FAIL), 'relogin')
})

test('网络类失败 ⇒ 放行但提示（warn）—— 本次事故命中的那条', () => {
  assert.equal(switchGateFromProbe(NET_FAIL), 'warn')
  // 反向：绝不能把网络类判成 relogin（那就退回了修复前的行为）
  assert.notEqual(switchGateFromProbe(NET_FAIL), 'relogin')
})

test('探活通过 ⇒ 直接切（ok）', () => {
  assert.equal(switchGateFromProbe(OK), 'ok')
})

test('没什么可探的（undefined）⇒ 不拦', () => {
  assert.equal(switchGateFromProbe(undefined), 'ok')
})

test('缺 errorKind 的旧结果按"未知"处理 ⇒ 不拦（宁可放行也不误判成失效）', () => {
  // 反例来源：0.6.6 之前写盘的记录没有分类字段；把它当 auth 会重现"逼人重登"的老毛病。
  assert.equal(switchGateFromProbe({ ok: false, at: 'x', error: 'fetch failed' }), 'warn')
})

test('交互路径的探活超时必须是有限数且短于后台默认的 20s', () => {
  assert.ok(Number.isFinite(SWITCH_PROBE_TIMEOUT_MS), '必须是有限数')
  assert.ok(SWITCH_PROBE_TIMEOUT_MS > 0, '必须为正')
  assert.ok(
    SWITCH_PROBE_TIMEOUT_MS < 20_000,
    `切换是点击交互，等 ${SWITCH_PROBE_TIMEOUT_MS}ms 太久（默认后台探活是 20s）`,
  )
})

console.log('\n宿主必须真的用上这个判据（防"判据写好了没人调用"）')

const hostSource = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
const switchRoute = hostSource.slice(
  hostSource.indexOf("route === '/accounts/switch'"),
  hostSource.indexOf("route === '/accounts/rename'"),
)

test('/accounts/switch 分支存在且调用了 switchGateFromProbe', () => {
  assert.ok(switchRoute.length > 0, '找不到 /accounts/switch 分支（是不是被改名了？）')
  assert.ok(
    switchRoute.includes('switchGateFromProbe('),
    '/accounts/switch 没有调用 switchGateFromProbe —— 分类处置失效，网络超时又会拦人',
  )
})

test('只有授权类分支才回 needsRelogin（网络类不许逼人重登）', () => {
  const reloginAt = switchRoute.indexOf('needsRelogin')
  const authGuardAt = switchRoute.indexOf("gate === 'relogin'")
  assert.ok(authGuardAt >= 0, '没有 gate === "relogin" 分支')
  assert.ok(
    reloginAt > authGuardAt,
    'needsRelogin 出现在授权分支之前 —— 网络类失败也会被当成"需要重新登录"',
  )
})

test('探活走的是交互用的超时常量，而不是写死的 20 秒', () => {
  assert.ok(
    /timeoutMs:\s*SWITCH_PROBE_TIMEOUT_MS/.test(switchRoute),
    '/accounts/switch 没有把 SWITCH_PROBE_TIMEOUT_MS 传给 probeOnce',
  )
})

console.log(`\n[switch-gate] ${passed}/${passed + failures.length} 通过`)
if (failures.length) {
  for (const item of failures) console.error(`  FAIL ${item}`)
  process.exitCode = 1
}
