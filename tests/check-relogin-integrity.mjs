/**
 * 重登引发的账号记录损坏 —— 两个都是 2026-09-17 下午现场实测出来的真 bug。
 *
 * 现场（`acc_d14996c7`，用户的申诉是"发个消息显示 API 密钥无效，同时账号退出"）：
 *
 *  ① **显示名被抹掉**：重登捕获来的凭证在 `unverified` 状态下拿不到 `user`，
 *     而 `upsertAccount` 的白名单里没有 `user` ⇒ 合并时 user 是空的，
 *     把原记录里可辨识的显示名覆盖没了。三个账号对照：
 *       acc_cdc0000f  user={"display":"137******78"}          ← 正常
 *       acc_ec650e63  user={"display":"lidi*********+mn1@gmail.com"}  ← 正常
 *       acc_d14996c7  user=null（但 serverId 还在）           ← 就是它，界面显示「未识别账号」
 *     注意 `serverId` 还在 ⇒ 这条记录本来是有身份的，不是新记录。
 *
 *  ② **重登死循环**：账号已被标记失效时，重登仍去**复用**浏览器里那份登录态 ——
 *     而那正是让它失效的那一份。日志实证（连点两次都一样）：
 *       14:53:22 「已捕获 token」（1 秒）→ 14:53:27 校验 invalid token
 *       14:54:05 再点 → 14:54:07 又是同一个
 *
 * 用法: node tests/check-relogin-integrity.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dswl-relogin-'))
process.env.DSH_HOME = HOME

const { upsertAccount, updateAccount, activeAccountId } = await import('../src/accounts.ts')
const { resetAccountIntents, pendingReloginTarget } = await import('../src/account-add.ts')

const API_RELOGIN = '/deepseek-web-login/api/login/relogin'
const PROFILE_DIR = join(HOME, 'web-login', 'browser-profile')

/** 不含 user 的基础凭证（每次都换 token，模拟"重登抓了一份新的回来"）。 */
function cred(token, extra = {}) {
  return {
    token,
    cookie: `c=${token}`,
    hifDliq: '',
    hifLeim: '',
    wasmUrl: '',
    userAgent: 'test-ua',
    capturedAt: new Date().toISOString(),
    ...extra,
  }
}

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

// ── ① upsert 必须保住 user（深合并）──────────────────────────────────────
console.log('① 重登 / 导入时不能把显示名抹掉')

const first = upsertAccount(cred('tk-1', { user: { id: 'srv-A', display: '137******78' } }), { serverId: 'srv-A' })
assert.ok(first.user?.display, `自证：第一条记录带上了显示名（${JSON.stringify(first.user)}）`)

await test('新凭证完全不带 user ⇒ 保留原显示名（现场就是这个形态）', () => {
  const next = upsertAccount(cred('tk-2'), { serverId: 'srv-A' })
  assert.equal(next.id, first.id, '自证：命中的是同一条记录（按 serverId 去重）')
  assert.deepEqual(
    next.user,
    { id: 'srv-A', display: '137******78' },
    `显示名必须保住，实际 ${JSON.stringify(next.user)}`,
  )
})

await test('新 user 只有 id、没有 display ⇒ 旧 display 不能被覆盖空', () => {
  const next = upsertAccount(cred('tk-3', { user: { id: 'srv-A' } }), { serverId: 'srv-A' })
  assert.equal(next.user?.display, '137******78', '缺的字段要沿用旧值')
  assert.equal(next.user?.id, 'srv-A')
})

await test('新 user 字段更全 ⇒ 用新的（合并不能变成"永远用旧的"）', () => {
  const next = upsertAccount(cred('tk-4', { user: { id: 'srv-A', display: '139******99' } }), { serverId: 'srv-A' })
  assert.equal(next.user?.display, '139******99', '新值优先')
})

await test('从没有过 user 的记录不会被凭空造出 user', () => {
  const fresh = upsertAccount(cred('tk-5'), {})
  assert.equal(fresh.user, undefined, `实际 ${JSON.stringify(fresh.user)}`)
})

// ── ② /login/relogin 先探活：能用就一键恢复，只有授权失效才清登录态 ─────────
//
// 0.6.6（2026-09-29 用户申诉「不能一键重登吗？点了又让我重输账号密码」）：
// 旧实现一进门就 `!!lastVerifyError ⇒ 先清 profile + 登录分区`，而那个标记常常来自
// **网络类失败**（实测 9 个账号同时被写成 `fetch failed`，宿主日志里是
// `net::ERR_NETWORK_IO_SUSPENDED` —— 机器休眠、网络挂起），凭证本身是好的。
// 清完之后浏览器里空空的 ⇒ 必然要重新登录一遍。现在改成先只读探一次。
console.log('\n② 重登先探活：网络类失败不清登录态，授权失效才清')

const { setFetchImpl } = await import('../src/webapi.ts')
const { readAccount } = await import('../src/accounts.ts')

/** 让探活返回指定结果（探活走 activeFetch，即这里注入的实现）。 */
function stubProbe(kind) {
  if (kind === 'ok') {
    setFetchImpl(async () =>
      new Response(
        JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: { user: { id: 'srv-any', email: 'a@b.c' } } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    return
  }
  if (kind === 'auth') {
    // 非 2xx ⇒ validateAuth 给出 `users/current HTTP 401`（授权类白名单认得它）
    setFetchImpl(async () => new Response('', { status: 401 }))
    return
  }
  // 传输类：外层是 "fetch failed"，真实原因在 cause 里 —— 与现场形态一致
  setFetchImpl(async () => {
    const cause = Object.assign(new Error('net::ERR_NETWORK_IO_SUSPENDED'), {
      code: 'net::ERR_NETWORK_IO_SUSPENDED',
    })
    throw Object.assign(new TypeError('fetch failed'), { cause })
  })
}

const stale = upsertAccount(cred('tk-stale', { user: { id: 'srv-S', display: '188******01' } }), { serverId: 'srv-S' })
updateAccount(stale.id, {
  lastVerifyError: { at: new Date().toISOString(), message: 'Authorization Failed (invalid token)' },
})
const healthy = upsertAccount(cred('tk-healthy', { user: { id: 'srv-H', display: '166******02' } }), { serverId: 'srv-H' })
assert.notEqual(stale.id, healthy.id, '自证：两个账号是两条记录')

let handler
{
  const { apply } = await import('../src/index.ts')
  const ctx = {
    effect: (fn) => fn(),
    llm: { registerAdapter() {}, listProviders: () => [] },
    webServer: { register: (opts) => { handler = opts.handler } },
    get: () => undefined,
  }
  apply(ctx, { probeIntervalMs: 0 })
  assert.equal(typeof handler, 'function', '自证：拿到了 HTTP handler')
}

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

function fakeRes() {
  const res = {
    statusCode: 0,
    body: '',
    writeHead(status) { res.statusCode = status },
    end(text) { res.body = text ?? '' },
  }
  return res
}

/** 造一个"浏览器登录态还在"的假象：profile 目录非空。 */
function seedProfile() {
  mkdirSync(PROFILE_DIR, { recursive: true })
  writeFileSync(join(PROFILE_DIR, 'marker.txt'), 'profile-in-use')
  assert.ok(existsSync(PROFILE_DIR), '自证：profile 目录已就位')
}

async function relogin(id) {
  resetAccountIntents()
  const res = fakeRes()
  await handler(fakeReq('POST', API_RELOGIN, { id }), res)
  assert.equal(res.statusCode, 200, `自证：relogin 返回 200（实际 ${res.statusCode} ${res.body.slice(0, 160)}）`)
  return JSON.parse(res.body)
}

await test('授权真的失效 ⇒ 清掉浏览器登录态，且引导重新登录一次', async () => {
  seedProfile()
  stubProbe('auth')
  const data = await relogin(stale.id)
  assert.equal(data.keptBrowserSession, false, 'keptBrowserSession 必须为 false 才与行为一致')
  assert.equal(existsSync(PROFILE_DIR), false, 'profile 目录应被清掉 —— 否则复用的一定还是那份坏登录态')
  assert.equal(pendingReloginTarget(), stale.id, '重登意图仍要指向这条记录（捕获后原地更新）')
  assert.ok(/重新登录一次/.test(String(data.hint ?? '')), `hint 要引导用户重新登录，实际 ${data.hint}`)
})

await test('🔴 网络类失败 ⇒ 不清登录态、不开窗口（"点重登还要我输密码"的根因）', async () => {
  seedProfile()
  stubProbe('transport')
  const data = await relogin(healthy.id)
  assert.equal(data.ok, false, '网络不通时不该继续往下走（否则必然白敲一遍密码）')
  assert.equal(data.network, true, '要明确告诉界面这是网络问题，而不是账号问题')
  assert.ok(/网络/.test(String(data.error ?? '')), `错误里要说明是网络问题，实际 ${data.error}`)
  assert.equal(existsSync(PROFILE_DIR), true, '网络类失败绝不能清登录态')
  assert.equal(pendingReloginTarget(), undefined, '不该进入登录流程（也就没有"重登意图"）')
  const record = readAccount(healthy.id)
  assert.ok(record?.lastCheckError, '网络类失败要落到 lastCheckError')
  assert.equal(record?.lastVerifyError, undefined, '🔴 不能被写成"授权失效"（徽章会因此误报"需要重新登录"）')
  assert.ok(
    /ERR_NETWORK_IO_SUSPENDED/.test(String(record?.lastCheckError?.message ?? '')),
    `原因链必须保留（否则只剩一句 fetch failed 没法排查），实际 ${record?.lastCheckError?.message}`,
  )
})

await test('探活通过 ⇒ 一键恢复：不清任何东西、也不打开登录窗口', async () => {
  seedProfile()
  stubProbe('ok')
  const data = await relogin(healthy.id)
  assert.equal(data.ok, true)
  assert.equal(data.alreadyValid, true, '要告诉界面"账号本来就是好的"')
  assert.ok(/不需要重新登录/.test(String(data.hint ?? '')), `hint 要说明不用重登，实际 ${data.hint}`)
  assert.equal(existsSync(PROFILE_DIR), true, 'profile 一个字节都不该动')
  const record = readAccount(healthy.id)
  assert.equal(record?.lastVerifyError, undefined, '失败标记必须被清掉（否则界面一直红着）')
  assert.equal(record?.lastCheckError, undefined, '上一次的"网络未能校验"也要一起清')
  assert.ok(record?.lastVerifiedAt, '探活成功要记时间')
  assert.equal(pendingReloginTarget(), undefined, '一键结束 —— 不该开浏览器')
})

await test('只有 unverified 不算"已失效"（捕获后短暂未校验是正常的）', async () => {
  // ⚠️ token 要 >8 字符，否则 hasUsableAuth 判"不可用" ⇒ 探活压根不跑（这个坑用例自己踩过一次）
  const mid = upsertAccount(cred('tk-mid-0123456789', { user: { id: 'srv-M', display: '155******03' } }), {
    serverId: 'srv-M',
  })
  updateAccount(mid.id, { unverified: true })
  seedProfile()
  stubProbe('transport')
  const data = await relogin(mid.id)
  assert.equal(existsSync(PROFILE_DIR), true, '未校验 + 网络失败都不该删登录态')
  assert.notEqual(data.keptBrowserSession, false, '不能声称"清了登录态"')
})

setFetchImpl(undefined)

console.log(`\n通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const failure of failures) console.log('  ' + failure)
if (failures.length) process.exitCode = 1
