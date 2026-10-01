#!/usr/bin/env node
/**
 * 反向验证：把 0.6.22 的两条修复各自"变异"回 bug，确认守它们的用例真的会红。
 *
 * 为什么必须做：用例全绿本身不能证明它有效 —— 一条永远为真的断言也是绿的。
 *
 * ⚠️ 两个踩过的坑，这个脚本专门防着：
 *  1. **spawn 失败 ≠ 测试失败**。第一版只看 `status !== 0` 就判"用例抓到了 bug"，
 *     而实际拿到的是 `error: EBUSY`（子进程根本没起来）、`status: null` ——
 *     **假通过**。所以现在必须先查 `result.error`，有错一律报 UNKNOWN。
 *  2. **变异点要打在"单一来源"上**。第一版把 `reset…()` 里的默认值写成字面量，
 *     于是"改默认值"的变异被 reset 抹掉，用例跑不出红。现在默认值收敛成常量。
 *
 * 若本机 spawn 持续 EBUSY（沙箱/杀软占用 node.exe），就手工做：
 *   改源码 → `node tests/check-context-feed.mjs; echo $?` → 必须 rc=1 → 还原。
 *
 * 用法: node dev/verify-fresh-session-guard.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const CASES = [
  {
    name: '把「不删」的 abandonQueue 改回 flush（＝0.6.21 的 bug：点不删反而触发删除）',
    file: 'src/webapi.ts',
    from: "if (policy.mode === 'keep') abandonQueue()",
    to: "if (policy.mode === 'keep') void flush()",
    suite: 'tests/check-context-feed.mjs',
  },
  {
    name: '把重开链的默认值改成"换新会话"（＝0.6.21：一个窗口聊两句多出三个会话）',
    file: 'src/context-feed.ts',
    from: 'export const DEFAULT_FRESH_SESSION_ON_RESTART = false',
    to: 'export const DEFAULT_FRESH_SESSION_ON_RESTART = true',
    suite: 'tests/check-context-feed.mjs',
  },
  {
    name: '把 canExtendChain 改回严格前缀（＝0.6.22：被运行时注入打穿 ⇒ 每轮断链）',
    file: 'src/context-feed.ts',
    from: '  return next[prev.length - 1] === prev[prev.length - 1]',
    to: '  return prev.every((line, i) => line === next[i])',
    suite: 'tests/check-context-feed.mjs',
  },
  {
    name: '让槽位淘汰重新删网页端会话（＝回到原窗口接不上，且是很强的机器特征）',
    file: 'src/webapi.ts',
    from: `    contextChains.delete(slot.key)
    if (lastChainKey === slot.key) lastChainKey = undefined
  }
}`,
    to: `    contextChains.delete(slot.key)
    if (lastChainKey === slot.key) lastChainKey = undefined
    retireSession(slot.sessionId)
    try {
      slot.cleanup?.(slot.sessionId)
    } catch {}
  }
}`,
    suite: 'tests/check-session-reuse.mjs',
  },
  {
    name: '把 replay 的 parent 改回 null（＝会发根消息 ⇒ 网页端分叉 / 修改重新生成）',
    file: 'src/context-feed.ts',
    from: `  const replay = (reason: FeedReason): FeedDecision => ({
    prompt: full,
    parentMessageId: chain.parentId,`,
    to: `  const replay = (reason: FeedReason): FeedDecision => ({
    prompt: full,
    parentMessageId: null,`,
    suite: 'tests/check-context-chain.mjs',
  },
]

let failures = 0
let skipped = 0
for (const item of CASES) {
  const original = readFileSync(item.file, 'utf8')
  if (!original.includes(item.from)) {
    console.log(`?? 变异点没找到，用例可能已失效：${item.file} :: ${item.from}`)
    failures += 1
    continue
  }
  writeFileSync(item.file, original.replace(item.from, item.to), 'utf8')
  let result
  try {
    result = spawnSync(process.execPath, [item.suite], { encoding: 'utf8' })
  } finally {
    writeFileSync(item.file, original, 'utf8') // 无论如何都还原
  }

  // 🔴 先看有没有 spawn 错误 —— 有错时 status 是 null，绝不能当成"用例抓到了 bug"
  if (result.error) {
    console.log(`SKIP ${item.name}`)
    console.log(`     子进程没起来（${result.error.message}）—— 变异验证未执行，不是通过`)
    skipped += 1
    continue
  }

  const caught = result.status !== 0
  const hits = (result.stdout ?? '')
    .split('\n')
    .filter((l) => l.includes('✗'))
    .slice(0, 3)
    .join('\n     ')
  console.log(`${caught ? 'OK  ' : 'BAD '} ${item.name}`)
  console.log(`     rc=${result.status}${hits ? `\n     ${hits}` : ''}`)
  if (!caught) failures += 1
}

if (skipped > 0) {
  console.log(`\n有 ${skipped} 条没跑成（子进程起不来）—— 这批用例是否有效**尚未验证**`)
}
if (failures === 0 && skipped === 0) {
  console.log('\n反向验证通过：两条守护用例都能抓到对应的 bug ✅')
}
if (failures > 0 || skipped > 0) process.exitCode = 1
