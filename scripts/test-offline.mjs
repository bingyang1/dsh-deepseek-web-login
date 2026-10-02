#!/usr/bin/env node
/**
 * 全量离线用例（审计 F20）。
 *
 * 只跑**不需要网络与账号**的用例（清单见 scripts/test-files.mjs）。
 * 明确排除 `probe-*.mjs` —— 那几个会打真实接口、需要有效账号，属于人工诊断工具。
 *
 * 为什么要有这个入口：CI 之前只写了 7 个测试文件名，手工维护容易漏；
 * 而"漏跑"的代价在这一轮审计里已经出现过多次（改了源码但没跑全量，回归晚几天才发现）。
 * 这里按文件名扫全量，新增用例自动纳入。
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pickOfflineTests } from './test-files.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const testsDir = join(ROOT, 'tests')
const files = pickOfflineTests(testsDir)

/**
 * 🔴 每个用例都在**临时** DSH_HOME 下跑。
 *
 * 用例会真实调用 `webLoginDir()` 那一族路径（投喂留痕、账号库、journal…），
 * 不隔离就直接写进用户真实的 `~/.dsh/web-login/`。2026-10-02 实测：一次全量跑批往
 * 用户的 `feed-decisions.jsonl` 灌了 695 条测试噪声（`sess-1..7` + 同一毫秒），
 * 诊断真实问题前得先手工把噪声滤掉 —— 诊断数据被污染比没有数据更糟。
 *
 * 用例自己仍可覆盖（既有用例就是 `process.env.DSH_HOME = mkdtempSync(...)`），
 * 这里是**兜底**：新写的用例忘了隔离也污染不到真实目录。
 */
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'dsh-web-login-tests-'))

/**
 * 需要更长上限的用例 —— **按文件名给**，不要全局放宽。
 *
 * `check-browser-transport` 会**真启一个浏览器**来验"浏览器代理能否发 POST / 上传 FormData"，
 * 而且每个用例各起一次。实测本机 **4 分 29 秒**（还只是"用户同时开着 DSH + Edge"的普通状态），
 * 远超 180s 的通用上限 ⇒ 跑批每轮都把它报成 FAIL，而它其实**是通过的**。
 *
 * ⚠️ 这类"红"比没有用例更糟：它会训练人忽略 FAIL。所以宁可给这一个文件放宽，也不改通用上限
 * （通用上限的语义是"超过就说明有东西挂住了"，放宽就失去意义）。
 * ⚠️ 真正的修法是让它**复用同一个浏览器会话**（5 个用例只起一次），那才是把它压回几十秒；
 * 在那之前先让跑批说实话。
 */
const SLOW_FILES = { 'check-browser-transport.mjs': 600_000 }

const failed = []
for (const file of files) {
  console.log(`\n=== ${file} ===`)
  const result = spawnSync(process.execPath, [join(testsDir, file)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, DSH_HOME: SANDBOX_HOME },
    // 单个文件的上限：超过说明有东西挂住了（而不是"慢"）。慢的用例见 SLOW_FILES。
    timeout: SLOW_FILES[file] ?? 180_000,
  })
  if (result.error || result.status !== 0) {
    failed.push(file)
    console.error(`FAIL ${file}${result.error ? `：${result.error.message}` : ''}`)
  }
}

try {
  rmSync(SANDBOX_HOME, { recursive: true, force: true })
} catch {
  /* 清理失败无所谓，临时目录 */
}

console.log(`\n[test] ${files.length - failed.length}/${files.length} 个用例文件通过`)
if (failed.length) {
  for (const file of failed) console.log(`  FAIL ${file}`)
  process.exitCode = 1
}
