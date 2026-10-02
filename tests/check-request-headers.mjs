/**
 * 回归：**我们发出去的头**（`pickExtraHeaders` + `buildDsHeaders`）。
 *
 * 背景（2026-10-02，对着真实登录捕获核对过）：我们往外发的头离"真浏览器"差两块：
 *
 *  ① 收头的规则只认 `x-*`，于是浏览器**自动加**的那一批全被丢了
 *     （`sec-ch-ua*` / `sec-fetch-*` / `priority`）。这批是"是不是真浏览器"最表层的信号，
 *     而且补上是零成本的。
 *  ② `x-client-version` 写死 `2.0.0`，而真实捕获（2026-10-02T03:42Z）是 `2.5.0` ——
 *     落后两个小版本，且**没有任何机制会发现它过时**。
 *
 * 这个文件重点守三件事：
 *  · 该收的收进来（且**保留浏览器给头的顺序** —— 顺序本身就是指纹）；
 *  · 不该收的别收（逐请求头收进来就会用旧值盖掉当前登录态；`accept-encoding` 更是收了会静默坏）；
 *  · 抓来的真值必须**赢过**写死的兜底。
 *
 * 用法: node tests/check-request-headers.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离：不设的话投喂留痕会写进用户真实的 ~/.dsh/web-login/（见 test-offline.mjs 的说明）
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-request-headers-'))

const { pickExtraHeaders } = await import('../src/browser-login.ts')
const { buildDsHeaders, FALLBACK_CLIENT_VERSION, FALLBACK_UA, DS_BASE } = await import('../src/webapi.ts')

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`  ✗ ${name}\n      ${error.message}`)
  }
}

console.log('请求头')

// ── 收头的白名单 ────────────────────────────────────────────────────────────

test('★ 浏览器自动加的指纹头要收进来（sec-ch-ua* / sec-fetch-* / priority / accept）', () => {
  const picked = pickExtraHeaders({
    'sec-ch-ua': '"Microsoft Edge";v="154", "Chromium";v="154"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    priority: 'u=1, i',
    accept: '*/*',
    'x-client-version': '2.5.0',
    'accept-language': 'zh-CN,zh;q=0.9',
  })
  assert.equal(picked['sec-ch-ua'], '"Microsoft Edge";v="154", "Chromium";v="154"', 'sec-ch-ua 必须收进来')
  assert.equal(picked['sec-ch-ua-platform'], '"Windows"')
  assert.equal(picked['sec-fetch-site'], 'same-origin')
  assert.equal(picked.priority, 'u=1, i')
  assert.equal(picked.accept, '*/*')
  assert.equal(picked['x-client-version'], '2.5.0')
})

test('★ 逐请求现算的头一个都不许收（收了就会用旧值盖掉当前登录态）', () => {
  const picked = pickExtraHeaders({
    authorization: 'Bearer OLD',
    cookie: 'old=1',
    'content-type': 'application/json',
    'content-length': '42',
    host: 'chat.deepseek.com',
    origin: 'https://chat.deepseek.com',
    referer: 'https://chat.deepseek.com/',
    'transfer-encoding': 'chunked',
    connection: 'keep-alive',
    'x-ds-pow-response': 'old-pow',
    'x-hif-dliq': 'old-dliq',
    'x-hif-leim': 'old-leim',
    'user-agent': 'old-ua',
    // 正向对照：同一次输入里必须**有东西被收下**，否则"全不收"也会让上面全绿
    'x-client-platform': 'web',
  })
  assert.deepEqual(picked, { 'x-client-platform': 'web' }, `不该收任何逐请求头，实际收下：${JSON.stringify(picked)}`)
})

test('★ accept-encoding 故意不收（收了服务端可能回 zstd，而 Node 侧解不开 ⇒ SSE 静默变乱码）', () => {
  const picked = pickExtraHeaders({
    'accept-encoding': 'gzip, deflate, br, zstd',
    'x-client-platform': 'web',
  })
  assert.equal(
    picked['accept-encoding'],
    undefined,
    '收了 accept-encoding 就有"服务端回 zstd、我们解不开、内容静默变乱码"的风险 —— 要收必须先验证解压链',
  )
  assert.equal(picked['x-client-platform'], 'web', '正向对照：同时必须还能收下别的头')
})

test('★ 收头要保留浏览器给的顺序（头的顺序本身就是指纹）', () => {
  const picked = pickExtraHeaders({
    'sec-ch-ua': 'a',
    'sec-fetch-site': 'same-origin',
    'x-client-version': '2.5.0',
    'x-client-platform': 'web',
    'x-device-id': 'uuid',
    priority: 'u=1, i',
  })
  assert.deepEqual(
    Object.keys(picked),
    ['sec-ch-ua', 'sec-fetch-site', 'x-client-version', 'x-client-platform', 'x-device-id', 'priority'],
    '顺序必须与进来的顺序一致',
  )
})

test('大写键名要归一成小写，但值不许动', () => {
  const picked = pickExtraHeaders({ 'X-Client-Version': '2.5.0', 'Sec-CH-UA': 'X' })
  assert.deepEqual(picked, { 'x-client-version': '2.5.0', 'sec-ch-ua': 'X' })
})

// ── 组装请求头 ──────────────────────────────────────────────────────────────

const AUTH = {
  token: 'TOKEN',
  cookie: 'c=1',
  userAgent: 'UA-FROM-BROWSER',
  hifDliq: 'DLIQ',
  hifLeim: 'LEIM',
}

test('★ 抓来的 x-client-version 必须赢过写死的兜底（写死值过时会功能降级）', () => {
  // ⚠️ 这里刻意用一个**与兜底不同**的值 —— 第一版我两边都写 '2.5.0'，
  // 于是"兜底覆盖抓取值"这个变异体也能通过（两者无法区分）⇒ 虚断言。
  const BROWSER_SAYS = '88.8.8'
  const headers = buildDsHeaders({ ...AUTH, extraHeaders: { 'x-client-version': BROWSER_SAYS } })
  assert.equal(
    headers['x-client-version'],
    BROWSER_SAYS,
    `抓来的真值被兜底盖掉了（拿到 ${headers['x-client-version']}）—— 优先级反了`,
  )
})

test('★ 抓来的指纹头要排在兜底前面（顺序即指纹）', () => {
  const headers = buildDsHeaders({
    ...AUTH,
    extraHeaders: { 'sec-ch-ua': '"Chromium";v="154"', 'x-client-version': '88.8.8' },
  })
  const keys = Object.keys(headers)
  assert.ok(
    keys.indexOf('sec-ch-ua') < keys.indexOf('accept'),
    `浏览器抓来的头必须排在补的兜底之前，实际：${keys.slice(0, 6).join(',')}`,
  )
})

test('没有抓到头时兜底仍要齐（且不是那个已经过时的 2.0.0）', () => {
  const headers = buildDsHeaders(AUTH)
  assert.equal(headers['x-client-version'], FALLBACK_CLIENT_VERSION)
  assert.ok(
    /^\d+\.\d+\.\d+$/.test(FALLBACK_CLIENT_VERSION),
    `兜底版本号必须是个像样的版本串，实际：${FALLBACK_CLIENT_VERSION}`,
  )
  assert.equal(headers['x-client-platform'], 'web')
  assert.equal(headers['accept-language'], 'zh-CN,zh;q=0.9,en;q=0.8')
})

test('★ 逐请求头必须用当前值 —— 快照里的旧 token / 旧 cookie / 旧 hif 全都不许漏出去', () => {
  const headers = buildDsHeaders({
    ...AUTH,
    extraHeaders: {
      authorization: 'Bearer OLD',
      cookie: 'old=1',
      'x-hif-dliq': 'OLD-DLIQ',
      'x-hif-leim': 'OLD-LEIM',
      'x-ds-pow-response': 'OLD-POW',
      'x-client-version': '2.5.0',
    },
  })
  assert.equal(headers.authorization, 'Bearer TOKEN', 'authorization 被快照里的旧值占了')
  assert.equal(headers.cookie, 'c=1', 'cookie 被快照里的旧值占了')
  assert.equal(headers['x-hif-dliq'], 'DLIQ')
  assert.equal(headers['x-hif-leim'], 'LEIM')
  assert.equal(headers['x-ds-pow-response'], undefined, 'pow 应答是按次生成的，绝不能复用旧值')
})

test('没有 cookie 时不许留下空的 cookie 头（空头本身也可疑）', () => {
  const headers = buildDsHeaders({ token: 'T' })
  assert.equal('cookie' in headers, false)
  assert.equal(headers['user-agent'], FALLBACK_UA)
  assert.equal(headers['content-type'], 'application/json')
  assert.equal(headers.origin, DS_BASE)
  assert.equal(headers.referer, `${DS_BASE}/`)
})

test('归属声明头仍在（它是主动申报，不是指带头，别顺手删掉）', () => {
  const headers = buildDsHeaders(AUTH)
  assert.match(String(headers['x-deepseek-harness'] ?? ''), /deepseek-harness/)
})

console.log()
console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 OK'}`)
for (const f of failures) console.log('  ' + f)
if (failures.length) process.exitCode = 1
