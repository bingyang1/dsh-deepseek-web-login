#!/usr/bin/env node
/**
 * 追一个会话里图片**出现在哪几条消息上**，用来判断"网页端为什么有图"。
 *
 * 要回答的问题：图片是**历史里的**（用户早先发的，链上重发属正常），
 * 还是**本轮凭空多出来的**（那就是 bug）。
 *
 * 用法: node dev/trace-session-images.mjs <session.v4.jsonl.zstd 路径>
 */
import { readFileSync } from 'node:fs'
import { gunzipSync, zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function readText(p) {
  const raw = readFileSync(p)
  if (p.endsWith('.gz')) return gunzipSync(raw).toString('utf8')
  if (!p.endsWith('.zstd')) return raw.toString('utf8')
  const starts = []
  for (let i = 0; i <= raw.length - 4; ) {
    const at = raw.indexOf(ZSTD_MAGIC, i)
    if (at < 0) break
    starts.push(at)
    i = at + 4
  }
  const out = []
  for (let k = 0; k < starts.length; k += 1) {
    const slice = raw.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : raw.length)
    try {
      out.push(zstdDecompressSync(slice).toString('utf8'))
    } catch {}
  }
  return out.join('')
}

const path = process.argv[2]
if (!path) {
  console.log('用法: node dev/trace-session-images.mjs <session.v4.jsonl.zstd>')
  process.exit(1)
}

const lines = readText(path).split('\n').filter(Boolean)
console.log(`日志行数: ${lines.length}\n`)

let index = 0
for (const line of lines) {
  index += 1
  let obj
  try {
    obj = JSON.parse(line)
  } catch {
    continue
  }
  const text = JSON.stringify(obj)
  const hasImage = /"type"\s*:\s*"image"/.test(text)
  const type = obj.type ?? obj.event ?? '?'
  // 只打印"用户消息"和"带图的行"，其它略过（日志很长）
  const role = obj?.message?.role ?? obj?.role ?? ''
  const isUser = role === 'user'
  if (!hasImage && !isUser) continue

  const summary = String(obj?.message?.content?.[0]?.text ?? obj?.text ?? '').slice(0, 70).replace(/\n/g, ' ')
  const imageCount = (text.match(/"type"\s*:\s*"image"/g) ?? []).length
  console.log(
    `#${String(index).padStart(3)} ${type.padEnd(12)} role=${String(role).padEnd(8)}` +
      `${hasImage ? ` 🖼×${imageCount}` : '    '} ${summary}`,
  )
}
