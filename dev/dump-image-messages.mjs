#!/usr/bin/env node
/**
 * 打印带图片的那些消息**完整内容**（文字 + 图片块的排列）。
 *
 * 用途：判断"网页端那张图挂在某一轮上"到底对不对 —— 如果 DSH 里那条消息本来就带图，
 * 网页端显示图是**符合事实**的；如果那条消息只有文字，图就是被错挂了。
 *
 * 用法: node dev/dump-image-messages.mjs <session.v4.jsonl.zstd>
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
const lines = readText(path).split('\n').filter(Boolean)

/** 递归找出所有 image 块，并返回它所在的消息文本。 */
function describe(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = describe(item, depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (value.type === 'image') {
    return {
      mediaType: value.mediaType ?? value.source?.media_type ?? '?',
      name: String(value.name ?? value.source?.name ?? '').slice(0, 50),
    }
  }
  for (const key of ['message', 'content', 'event', 'data', 'item', 'payload']) {
    if (key in value) {
      const hit = describe(value[key], depth + 1)
      if (hit) return hit
    }
  }
  return null
}

let index = 0
let found = 0
for (const line of lines) {
  index += 1
  // 只在"用户消息"这一层找，避免把注入的运行时快照也算进来
  if (!/"role"\s*:\s*"user"/.test(line)) continue
  const hit = describe(JSON.parse(line))
  if (!hit) continue
  found += 1
  // 把这条消息里的**文本片段**全抽出来，看清"图 + 文字"的排布
  const texts = [...line.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.){0,120})"/g)].map((m) => m[1])
  console.log(`\n#${index}  图片: ${hit.mediaType} name=${hit.name}`)
  console.log(`   文本片段: ${texts.length ? texts.map((t) => JSON.stringify(t)).join('\n             ') : '(没有文本块)'}`)
}
console.log(`\n共 ${found} 条带图的用户消息`)
