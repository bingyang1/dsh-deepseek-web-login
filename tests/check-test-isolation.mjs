/**
 * 守卫：**测试不许写进用户真实的 `~/.dsh`**。
 *
 * 背景（2026-10-02 实测）：一次 `npm run test` 往用户真实的
 * `~/.dsh/web-login/feed-decisions.jsonl` 灌了 695 条测试噪声（`sess-1..7`、同一毫秒），
 * 排查真实问题时得先手工把噪声滤掉。诊断数据被污染比没有数据更糟。
 *
 * 成因是**两层都漏**：
 *  ① 4 个用例（fetch-injection / session-lifecycle / session-reuse / sse-wasm）没设 DSH_HOME
 *     ⇒ 落回 `~/.dsh`；别的用例早就用 `process.env.DSH_HOME = mkdtempSync(...)` 隔离了；
 *  ② 跑批脚本 `test-offline.mjs` 没有兜底 —— 任何一个新用例忘了隔离就再次污染。
 *
 * 所以本文件守两条，缺一条都会复发：
 *  A. 兜底：跑批脚本必须给子进程注入临时 DSH_HOME；
 *  B. 逐个：凡是会走 `streamWebCompletion`（唯一写投喂留痕的入口）的用例，自己也得隔离
 *     —— 单独 `node tests/xxx.mjs` 直接跑时，兜底是不生效的。
 *
 * ⚠️ 刻意断言"存在性"而不是写死名单：新用例自动纳入，不用维护。
 *
 * 用法: node tests/check-test-isolation.mjs
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push(`x ${name}: ${error?.message ?? error}`)
  }
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const testsDir = join(ROOT, 'tests')

const testFiles = readdirSync(testsDir).filter((n) => /^check-.*\.mjs$/.test(n))
/**
 * 会写投喂留痕的用例（`streamWebCompletion` 是唯一入口）。
 * ⚠️ 判据要求**真的 import 了 src** —— 只看"文件里出现过这个词"会把
 * `check-bundle.mjs` 一起算进来（它只在注释里提到这个名字，读的是 lib/，不碰状态）。
 * 误报会让这条守卫迟早被人当噪音关掉。
 */
const stateful = testFiles.filter((n) => {
  const s = readFileSync(join(testsDir, n), 'utf8')
  const importsSrc = /from\s*['"]\.\.\/src\//.test(s) || /import\(\s*['"]\.\.\/src\//.test(s)
  return importsSrc && /\bstreamWebCompletion\b/.test(s)
})

test('★ 扫描本身有效（找不到任何会写状态的用例 ⇒ 判据失效，必须报红）', () => {
  assert.ok(
    stateful.length >= 5,
    `只扫到 ${stateful.length} 个会写状态的用例，明显不对（判据失效会让本文件变成永远通过）`,
  )
  assert.ok(testFiles.length >= 40, `只扫到 ${testFiles.length} 个用例文件，目录解析可能错了`)
})

test('★ 每个会写状态的用例都必须自己钉住 DSH_HOME（直接单跑也不能污染真实目录）', () => {
  const offenders = stateful.filter((n) => {
    const s = readFileSync(join(testsDir, n), 'utf8')
    // 认「先赋值 + 真的用了 mkdtempSync」——只写个空串不算隔离
    return !(/process\.env\.DSH_HOME\s*=/.test(s) && s.includes('mkdtempSync'))
  })
  assert.deepEqual(
    offenders,
    [],
    `这些用例会把留痕写进用户真实的 ~/.dsh：${offenders.join(', ')}\n` +
      `修法：在文件顶部加 process.env.DSH_HOME = mkdtempSync(join(tmpdir(), '<名字>-'))`,
  )
})

test('★ 跑批脚本必须给子进程注入临时 DSH_HOME（兜底，防新用例忘了隔离）', () => {
  const runner = readFileSync(join(ROOT, 'scripts', 'test-offline.mjs'), 'utf8')
  assert.ok(
    /env:\s*\{[^}]*DSH_HOME:/.test(runner),
    'scripts/test-offline.mjs 没给子进程注入 DSH_HOME ⇒ 任何一个忘了隔离的新用例都会污染用户真实数据',
  )
  assert.ok(
    runner.includes('mkdtempSync') && runner.includes('tmpdir'),
    '兜底的 DSH_HOME 必须指向临时目录（要有 mkdtempSync + tmpdir）',
  )
})

console.log(
  failures.length === 0
    ? `\n通过 ${passed} 项，全部通过 ✅（已守 ${stateful.length} 个写状态的用例）`
    : `\n通过 ${passed} 项，失败 ${failures.length} 项 ❌\n${failures.join('\n')}`,
)
if (failures.length > 0) process.exitCode = 1
