#!/usr/bin/env node
/**
 * 扫一个 DSH 会话日志，回答一个问题：**这个会话的历史里到底有没有图片**。
 *
 * 为什么要这个：2026-10-02 用户报「我这次没发图片，网页端却有图片」。
 * 判断"该不该有图"只看一件事 —— 发给适配器的 messages 里有没有 image 块。
 * 凭界面截图猜不出来（DSH 的界面上看不到历史里的图片块）。
 *
 * 用法: node dev/scan-session-images.mjs [会话目录或 jsonl 路径]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { gunzipSync, zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'

/** 会话日志的文件名 —— ⚠️ 三种压缩都可能出现（v3/v4 × 无/gz/zstd）。 */
const SESSION_FILE = /^session\.v\d+\.jsonl(\.gz|\.zstd)?$/

const target = process.argv[2] ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'sessions')

/** 找最近的会话日志（按 mtime）。文件名随版本变（v4…），按前缀认。 */
function newestSessionFile(dir) {
  const out = []
  const walk = (d, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (SESSION_FILE.test(e.name)) out.push({ p, at: statSync(p).mtimeMs })
    }
  }
  walk(dir, 0)
  out.sort((a, b) => b.at - a.at)
  return out
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 解出会话日志的文本。
 *
 * 🔴 两个坑（2026-10-02 各踩一次）：
 *  1. DSH 写的是 **zstd**（`session.v4.jsonl.zstd`），只认 `.gz` 会静默扫不到 ——
 *     表现成"会话日志不存在"，而文件明明在（`tools/inspect-session.mjs` 早就修过这条）。
 *  2. 它是**多帧**的（实测一个 70KB 的文件有 34 个 zstd 帧，一帧一行），
 *     而 `zstdDecompressSync()` **只解第一帧** —— 拿到的只是那行 session header，
 *     后面所有消息全丢了，于是"含 image 块的行数"永远是 0（假阴性，比报错更坏）。
 *     所以要按 magic 切帧、逐帧解、拼起来。
 */
function readText(p) {
  const raw = readFileSync(p)
  if (p.endsWith('.gz')) return gunzipSync(raw).toString('utf8')
  if (!p.endsWith('.zstd')) return raw.toString('utf8')

  const text = []
  const starts = []
  for (let i = 0; i <= raw.length - ZSTD_MAGIC.length; ) {
    const at = raw.indexOf(ZSTD_MAGIC, i)
    if (at < 0) break
    starts.push(at)
    i = at + ZSTD_MAGIC.length
  }
  for (let k = 0; k < starts.length; k += 1) {
    const slice = raw.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : raw.length)
    try {
      text.push(zstdDecompressSync(slice).toString('utf8'))
    } catch {
      /* 切错帧就跳过：magic 也可能恰好出现在压缩数据里 */
    }
  }
  return text.length > 0 ? text.join('') : zstdDecompressSync(raw).toString('utf8')
}

const files = statSync(target).isDirectory() ? newestSessionFile(target) : [{ p: target, at: Date.now() }]
if (files.length === 0) {
  console.log('没找到会话日志')
  process.exit(0)
}

for (const f of files.slice(0, 5)) {
  const text = readText(f.p)
  const lines = text.split('\n').filter(Boolean)
  // 图片块在这份日志里的真实形态：消息内容里带 {"type":"image", ...}
  const imageLines = lines.filter((l) => /"type"\s*:\s*"image"/.test(l))
  // 顺带看"用户到底发了什么"：只取纯文本消息，确认里面有没有提到图
  const humanTexts = []
  for (const l of lines) {
    const m = /"text"\s*:\s*"([^"]{1,80})"/.exec(l)
    if (m && /"role"\s*:\s*"user"/.test(l)) humanTexts.push(m[1])
  }
  console.log(`\n=== ${f.p} ===`)
  console.log(`  修改时间: ${new Date(f.at).toISOString().replace('T', ' ').slice(0, 19)}`)
  console.log(`  日志行数: ${lines.length}`)
  console.log(`  含 image 块的行: ${imageLines.length}`)
  if (imageLines.length > 0) {
    const one = imageLines[0]
    const media = /"mediaType"\s*:\s*"([^"]+)"/.exec(one)?.[1] ?? '(无 mediaType)'
    const name = /"name"\s*:\s*"([^"]+)"/.exec(one)?.[1] ?? ''
    console.log(`  样例: mediaType=${media} name=${name.slice(0, 60)}`)
  }
  console.log(`  用户消息样本: ${humanTexts.slice(-5).join(' | ') || '(没抓到)'}`)
}
