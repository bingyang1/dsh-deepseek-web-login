/**
 * 自动重登的判据与凭证库回归（0.6.14）。
 *
 * 背景：网页端凭证实测寿命 **≈2 小时**（三个号分别活 88 / 119 / 120 分钟），到期后回
 * `40003 invalid token`；而官方桌面端里插件拿不到 Electron / 浏览器分区
 * （`/login/recover` 直接回"当前环境不是 Electron 桌面端"）。
 * 唯一可行路径是"用存的邮箱密码 + 真实浏览器登录"，于是**密码从哪来、匹配给谁、
 * 什么时候该重登**就成了必须钉死的判据 —— 错了不是崩溃，而是"悄悄不再重登"或
 * "把 A 的密码用到 B 上"，都很难发现。
 *
 * 用法: node tests/check-relogin.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 先钉住 DSH_HOME，别碰真实 ~/.dsh
const HOME = mkdtempSync(join(tmpdir(), 'dswl-relogin-'))
process.env.DSH_HOME = HOME

const {
  TOKEN_RENEW_AFTER_MS,
  credentialForDisplay,
  credentialsPath,
  maskLocalPart,
  readCredentialEntries,
  removeCredential,
  saveCredential,
  selectReloginTargets,
} = await import('../src/relogin.ts')
const { buildAutoLoginExpression } = await import('../src/browser-login.ts')
const { readFileSync } = await import('node:fs')

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(` ✓ ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error?.message ?? error}`)
    console.log(` ✗ ${name}\n   ${error?.message ?? error}`)
  }
}

// ── 脱敏匹配：必须与服务端规则一致，否则"匹配不上"会被误判成"没有密码" ─────────
// 样本取自真实账号（两条都是实测 display 原文）。
test('脱敏规则与服务端一致（真实样本）', () => {
  assert.equal(maskLocalPart('davidciwu33+w4@gmail.com'), 'davi*******+w4@gmail.com')
  assert.equal(maskLocalPart('zanaphiwu69+w68@gmail.com'), 'zana********w68@gmail.com')
})
test('本地部分太短 ⇒ 不猜（返回 undefined）', () => {
  assert.equal(maskLocalPart('abc@x.com'), undefined)
  assert.equal(maskLocalPart('ab@gmail.com'), undefined)
  assert.equal(maskLocalPart('没有@的串'), undefined)
})
test('按脱敏名找凭证：命中；对不上就是 undefined（不许模糊匹配）', () => {
  const entries = [{ email: 'davidciwu33+w6@gmail.com', password: 'p' }]
  assert.equal(credentialForDisplay('davi*******+w6@gmail.com', entries)?.password, 'p')
  // 同前缀不同尾号 —— 这条最重要：绝不能拿 +w5 的密码去登 +w6
  assert.equal(credentialForDisplay('davi*******+w5@gmail.com', entries), undefined)
  // 域名不同
  assert.equal(credentialForDisplay('davi*******+w6@other.com', entries), undefined)
  assert.equal(credentialForDisplay(undefined, entries), undefined)
})

// ── 凭证读写（原子、大小写不敏感去重、坏文件不崩） ──────────────────────────
test('写入 / 读取 / 去重 / 删除', () => {
  saveCredential('a@x.com', 'p1')
  saveCredential('b@x.com', 'p2')
  saveCredential('A@X.com', 'p3') // 大小写不同 = 同一条，覆盖
  const entries = readCredentialEntries()
  assert.equal(entries.length, 2, `去重失败：${JSON.stringify(entries)}`)
  assert.equal(entries.find((e) => e.email.toLowerCase() === 'a@x.com')?.password, 'p3', '应被覆盖为新密码')
  assert.equal(removeCredential('a@x.com'), true)
  assert.equal(removeCredential('a@x.com'), false, '删过了再删应返回 false')
  assert.equal(readCredentialEntries().length, 1)
  assert.ok(credentialsPath().includes('web-login'), '凭证应落在 web-login 目录下')
})

// ── 挑"该重登"的账号 ──────────────────────────────────────────────────────
const creds = [
  { email: 'davidciwu33+w4@gmail.com', password: 'p' },
  { email: 'zanaphiwu69+w68@gmail.com', password: 'p' },
]
const now = Date.parse('2026-09-30T22:00:00Z')
const minutesAgo = (n) => new Date(now - n * 60_000).toISOString()

test('只挑"已失效 / 快到期"的（自动续期用 onlyStale）', () => {
  const targets = selectReloginTargets({
    accounts: [
      // 已失效
      { id: 'a', capturedAt: minutesAgo(130), lastVerifyError: { at: minutesAgo(5) }, user: { display: 'davi*******+w4@gmail.com' } },
      // 快到期（>100 分钟）
      { id: 'b', capturedAt: minutesAgo(110), user: { display: 'zana********w68@gmail.com' } },
    ],
    entries: creds,
    now,
    onlyStale: true,
  })
  assert.equal(targets.length, 2)
  assert.equal(targets.find((t) => t.accountId === 'a')?.reason, 'expired')
  assert.equal(targets.find((t) => t.accountId === 'b')?.reason, 'expiring')
})
test('还新鲜的号不挑（自动续期不该白跑浏览器）', () => {
  const targets = selectReloginTargets({
    accounts: [{ id: 'c', capturedAt: minutesAgo(10), user: { display: 'davi*******+w4@gmail.com' } }],
    entries: creds,
    now,
    onlyStale: true,
  })
  assert.equal(targets.length, 0)
})
test('手动「一键重登」= 全刷（不看到期没到期）', () => {
  const targets = selectReloginTargets({
    accounts: [{ id: 'c', capturedAt: minutesAgo(10), user: { display: 'davi*******+w4@gmail.com' } }],
    entries: creds,
    now,
  })
  assert.equal(targets.length, 1)
  assert.equal(targets[0]?.reason, 'manual')
})
test('没有凭证 / 匹配不上的账号不会被挑（避免拿错密码）', () => {
  const targets = selectReloginTargets({
    accounts: [
      { id: 'x', capturedAt: minutesAgo(200), user: { display: 'nobody*****@gmail.com' } },
      { id: 'y', capturedAt: minutesAgo(200) },
    ],
    entries: creds,
    now,
  })
  assert.equal(targets.length, 0)
})
test('阈值就是实测寿命的量级（2 小时 / 提前 20 分钟）', () => {
  assert.equal(TOKEN_RENEW_AFTER_MS, 100 * 60_000)
})

// ── 页面内登录脚本：这几条是整条链路的支点，必须守 ──────────────────────────
test('页面登录脚本：打到正确接口 + 用数美 device_id + 回写 localStorage', () => {
  const expr = buildAutoLoginExpression('a@x.com', 'pw')
  assert.ok(expr.includes('/api/v0/users/login'), '必须打密码登录接口')
  assert.ok(expr.includes('SMSdk'), '必须取自数美 SDK 的 device_id（否则风控判 RISK_DEVICE_DETECTED）')
  assert.ok(expr.includes('device_id'), '请求体必须带 device_id')
  assert.ok(expr.includes("localStorage.setItem('userToken'"), '必须把 token 回写 localStorage，主流程才能照旧捕获')
  assert.ok(expr.includes('"a@x.com"'), '邮箱要作为字面量注入')
})
test('页面登录脚本：网址/密码里的特殊字符不会破坏脚本', () => {
  // 密码里带引号与反斜杠 —— 拼错就是"页面里报错"，而且只在特定密码下才复现
  const expr = buildAutoLoginExpression('a"b@x.com', 'p"w\\1')
  assert.ok(expr.includes('\\"'), '引号必须被转义')
  // 自证：整段能被 JavaScript 解析（语法错会在这里直接抛）
  assert.doesNotThrow(() => new Function(`return ${expr}`))
})

// ── 接线守卫：判据写好了必须真的被调用 ────────────────────────────────────
test('index.ts 真的接上了：自动重登 + 一键重登 + 定时检查读开关', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.ok(src.includes('autoReloginOne('), '必须定义/调用 autoReloginOne')
  assert.ok(src.includes("route === '/login/relogin-all'"), '必须有一键重登路由')
  assert.ok(/credentialForDisplay\(target\.user\?\.display\)/.test(src), '单条重登要先按脱敏名找凭证')
  assert.ok(
    /setInterval\([\s\S]{0,1200}?readGateSettings\(\)\?\.autoRelogin !== true/.test(src),
    '定时检查必须每轮重读设置（否则开关要重启才生效）',
  )
})
test('browser-login 的自动登录失败不会掐死手动路径', () => {
  const src = readFileSync(new URL('../src/browser-login.ts', import.meta.url), 'utf8')
  assert.ok(src.includes('if (options.credentials)'), '要给 browserLogin 加 credentials 入口')
  assert.ok(/autoLoginError = auto\.error/.test(src), '失败要记下原因再继续等手动登录')
  assert.ok(src.includes('autoLoginError ? { autoLoginError }'), '原因要带进结果里')
})

console.log(`\n通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项 ❌` : '，全部通过 ✅'}`)
for (const f of failures) console.log('  - ' + f)
if (failures.length) process.exitCode = 1
rmSync(HOME, { recursive: true, force: true })
