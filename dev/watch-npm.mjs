/**
 * 等 npm registry 上出现目标版本（刚发布时 CDN 有延迟）。
 * 用法: node watch-npm.mjs 0.6.7 [最大轮数]
 */
const want = process.argv[2]
const max = Number(process.argv[3] ?? 30)
const url = 'https://registry.npmjs.org/dsh-deepseek-web-login/latest'

for (let i = 0; i < max; i++) {
  try {
    const res = await fetch(`${url}?t=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } })
    const json = await res.json()
    if (json?.version === want) {
      console.log(`\nnpm 上已是 ${json.version}`)
      process.exit(0)
    }
    process.stdout.write(`${json?.version ?? '?'} `)
  } catch (error) {
    process.stdout.write(`!\n${error?.message}\n`)
  }
  await new Promise((resolve) => setTimeout(resolve, 10_000))
}
console.log(`\n超时：npm 上还没出现 ${want}`)
process.exit(2)
