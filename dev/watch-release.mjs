/**
 * 轮询 GitHub Actions 的 Release 工作流，等它跑完。
 * 用法: node watch-release.mjs <sha前缀> [最大轮数]
 */
const sha = process.argv[2]
const max = Number(process.argv[3] ?? 30)
const url = 'https://api.github.com/repos/cv-superding/dsh-deepseek-web-login/actions/runs?per_page=5'

for (let i = 0; i < max; i++) {
  try {
    const res = await fetch(`${url}&t=${Date.now()}`)
    const json = await res.json()
    const run = (json.workflow_runs ?? []).find(
      (x) => x.name === 'Release' && String(x.head_sha).startsWith(sha),
    )
    if (run?.status === 'completed') {
      console.log(`\nRelease ${run.conclusion} @ ${String(run.head_sha).slice(0, 7)} (${run.html_url})`)
      process.exit(run.conclusion === 'success' ? 0 : 1)
    }
  } catch (error) {
    console.log(`\n查询失败（继续重试）：${error?.message ?? error}`)
  }
  process.stdout.write('.')
  await new Promise((resolve) => setTimeout(resolve, 10_000))
}
console.log('\n超时：Release 还没跑完')
process.exit(2)
