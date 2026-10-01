/**
 * 临时诊断插桩：往**已安装的产物**里插一小段记录，接到现成的 /context-mode 接口上。
 *
 * 目的：查"链式投喂为什么每轮新建会话"。现在只知道现象（租用台账里一串新会话），
 * 不知道命中的是哪条判据 —— 而判据只在**变化时**才写宿主日志，且宿主日志不落盘。
 *
 * 插桩内容（全部只读、不改任何业务逻辑）：
 *  1. 一个环形缓冲 + 落盘 jsonl（`~/.dsh/web-login/diag-feed.jsonl`）；
 *  2. 每轮决策：reason / prompt 长度 / DSH 会话 id / parent；
 *  3. 每次租用：slotKey（含 DSH 会话 id）/ forceNew / 命中旧槽否 / 新建的会话 id；
 *  4. `/context-mode` 响应里多一个 `diag` 字段（最近 12 条）。
 *
 * ⚠️ 这是**应急诊断**：改的是 node_modules 里的产物，不是源码。要生效需重启 DSH。
 * 用完/修好后装正式版即可覆盖掉。
 *
 * 用法: node dev/patch-diag.mjs
 */
import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'

const TARGET = 'C:/Users/29436/.dsh/profiles/desktop/node_modules/dsh-deepseek-web-login/lib/index.js'
/** 干净底稿：仓库里这份是 0.6.15 的构建产物，与 npm 上的一致。
 *  ⚠️ 不要拿 TARGET 自己当"备份再还原" —— 第一次插桩脚本就是这么写的：
 *  它先把（已插桩的）target 拷成 backup，于是"还原"其实还原了插桩版 ⇒ 重复声明。
 *  这类"备份源不干净"的坑，只有把底稿固定在**它处**才能避免。 */
const PRISTINE = new URL('../lib/index.js', import.meta.url).pathname.replace(/^\//, '')
const DIAG_FILE = 'C:/Users/29436/.dsh/web-login/diag-feed.jsonl'
const BACKUP = `${TARGET}.bak-20261001`

let src = readFileSync(TARGET, 'utf8')
if (src.includes('__DIAG_PATCH__')) {
  console.log('目标里已有插桩 ⇒ 从仓库底稿还原后重插。')
  src = readFileSync(PRISTINE, 'utf8')
  if (src.includes('__DIAG_PATCH__')) throw new Error('仓库底稿也带插桩标记，先重建 lib 再跑')
}
writeFileSync(BACKUP, src)

/** 严格替换：找不到 / 命中多次都报错，绝不做"大概对"的改动。 */
function patch(anchor, insert, { before = false, label = '' } = {}) {
  const first = src.indexOf(anchor)
  if (first < 0) throw new Error(`锚点没找到：${label || anchor.slice(0, 40)}`)
  if (src.indexOf(anchor, first + 1) >= 0) throw new Error(`锚点命中多次：${label || anchor.slice(0, 40)}`)
  src = before ? src.slice(0, first) + insert + src.slice(first) : src.slice(0, first + anchor.length) + insert + src.slice(first + anchor.length)
  console.log(`  ✓ ${label || anchor.slice(0, 40)}`)
}

const RING = `
/* __DIAG_PATCH__ 临时诊断（2026-10-01）：查"链式投喂为什么每轮新建会话"。
   插的是**已安装产物**，不是源码；修好后装正式版即覆盖。 */
const __DIAG = [];
function __diagPush(o) {
	try {
		__DIAG.push(o);
		if (__DIAG.length > 60) __DIAG.shift();
		appendFileSync(${JSON.stringify(DIAG_FILE)}, JSON.stringify(o) + "\\n");
	} catch (e) {}
}
`
const SNAPSHOT = `
function __diagSnapshot() {
	return { lastFeed: lastFeedReason ?? null, slots: [...reuseSlots.keys()], recent: __DIAG.slice(-12) };
}
`

console.log('插桩：')
// ① 环形缓冲 + 落盘（挂在 lastFeedReason 声明后面）
patch('let lastFeedReason;', RING + SNAPSHOT, { label: '环形缓冲 + 快照函数' })
// ② 每轮决策都记（原来只在"原因变化"时才回调，诊断需要每轮）
patch(
  '\t\tif (feed.reason !== lastFeedReason) {',
  '\t\t__diagPush({ t: "feed", at: Date.now(), reason: feed.reason, chars: String(feed.prompt ?? "").length, dsh: params.dshSessionId ?? null, parent: feed.parentMessageId ?? null, session: lease.sessionId });\n',
  { before: true, label: '每轮决策记录' },
)
// ③ 每次租用（含归属键 = 账号 + DSH 会话 id）
patch(
  '\tconst slot = reuseSlots.get(key);',
  '\n\t__diagPush({ t: "lease", at: Date.now(), key, forceNew, limit, hit: !!slot, turns: slot?.turns ?? null });',
  { label: '租用记录' },
)
// ④ 真的新建了会话
patch('\tevictIdleSlots();', '\n\t__diagPush({ t: "new-session", at: Date.now(), key, sessionId });', { label: '新建会话记录' })
// ⑤ 接到 /context-mode 的响应上（不改任何业务字段，只加一个 diag）
// ⚠️ 锚点是那个对象**最后一个属性**（原文没有尾逗号），所以逗号要放在插入串的开头 ——
// 第一次就是漏了这个逗号，产物语法直接坏掉（`Unexpected identifier 'diag'`），
// 好在插完立刻 import() 验了一遍才没带病交付。
patch('pendingCleanup: sessionCleaner.pendingCount()', ',\n\t\t\t\t\t\tdiag: __diagSnapshot()', { label: '接口回传 diag' })
// ⑥ 最关键的一处：head 变了就记下"从第几个字符开始不同、两侧各是什么"。
// `head` = system + 协议指令 + 工具目录，这三者任一变化都会让链作废；只报 `head-changed`
// 等于没说，定位不到是谁变了（是 system 里带了时间？还是工具目录随轮次变？）。
patch(
  '\tif (chain.head !== head) return restart("head-changed");',
  `
	if (chain.head !== head) {
		const __a = String(chain.head);
		const __b = String(head);
		let __i = 0;
		while (__i < __a.length && __i < __b.length && __a[__i] === __b[__i]) __i++;
		__diagPush({
			t: "head-diff", at: Date.now(), at_index: __i,
			old_len: __a.length, new_len: __b.length,
			old_around: __a.slice(Math.max(0, __i - 70), __i + 70),
			new_around: __b.slice(Math.max(0, __i - 70), __i + 70)
		});
		return restart("head-changed");
	}`,
  { label: 'head 差异定位' },
)

writeFileSync(TARGET, src)
console.log(`\n已写入（备份在 ${BACKUP}，${src.length} 字节）`)
