/**
 * 自动切换账号 —— **纯逻辑**（不碰 fs、不碰网络，便于单测）。
 *
 * 定位：按时间把当前账号轮换到下一个，让每个账号分到的请求都变少（摊薄单账号密度）。
 *
 * 主路径是**按时间均衡轮换**：每个号的密度都斜下来，是**分散**。
 *
 * ⚠️ 但"遇限流就换"曾经是明确不做的 —— 同一个出口 IP 上多号交替活跃，更像"有组织的规避"。
 * 0.5.2 起改成一个**受限的**第三条路径（见 `isThrottleSwitchAllowed`）：
 *   - 只在"**刚**被限流"（窗口内）且距上次换号已过冷却期时才换；
 *   - 换完就清标记、并按冷却期挡住下一次 ⇒ 不会因为"每个号都被限流"而连环换完整个账号库。
 * 取舍：限流时那个号本来就发不出去，干等退避只是把整轮任务卡死（实测退避 20s 后重试策略
 * 直接放弃了）；换号能让任务接着跑。代价是交替比纯定时轮换密一点 —— 用冷却把上限压住。
 *
 * 真正的执行在宿主（`index.ts` 的切号钩子）：它才有探活与 `setActiveAccount`。
 * 本模块只回答两个问题：**该不该切**、**切给谁**。
 */

/**
 * 「刚被限流」的判定窗口：限流发生在这么久以内，才认为"现在换号有用"。
 *
 * 取值依据（本机台账实测 9 次限流）：限流解除后成功的间隔落在 27.8s ~ 593s，
 * 说明限流窗口至少几十秒、可能十几分钟 ⇒ 太短的窗口会漏掉"还在窗口里"的情况，
 * 太长则会在限流早就过去之后还多换一次号。3 分钟是这两者的折中。
 */
export const THROTTLE_SWITCH_WINDOW_MS = 3 * 60_000

/**
 * 因限流换号的**冷却期**：距上一次换号不足这么久，就不许再因限流换。
 *
 * 防的是最坏情况 —— 账号库里 9 个号接力被限流 ⇒ 几分钟内把 9 个号轮一遍，
 * 那正是"有组织的规避"的形态。有冷却之后，换号频率的上限与定时轮换同一量级。
 */
export const THROTTLE_SWITCH_COOLDOWN_MS = 3 * 60_000

/**
 * 本模块只描述它关心的字段 —— 刻意**不 import `accounts.ts`**。
 *
 * 理由：那边依赖 `node:fs`，而本项目有过"浏览器产物被 node 模块带崩"的前科
 * （见账号分组那段的注释）。用最小结构类型（鸭子类型）既避开这个坑，
 * 也让本模块在单测里可以纯粹用字面量构造输入。
 */
export interface SwitchableAccount {
  id: string
  /** 登录态失效标记（探活失败留下的）。有值 ⇒ 切过去必然失败，不选它。 */
  lastVerifyError?: { at: string; message: string }
  /** 观测到的账号级限制。`untilMs > now` 表示还在受限窗口里。 */
  limit?: { untilMs: number; observedAt: string }
}

/** 这个账号**现在**能用吗（未失效、未受限）。 */
export function isUsable(account: SwitchableAccount, now: number): boolean {
  if (account.lastVerifyError) return false
  const until = Number(account.limit?.untilMs)
  if (Number.isFinite(until) && until > now) return false
  return true
}

/**
 * 到点了吗。
 *
 * `lastSwitchAt` 由调用方负责给一个有意义的起点（插件启动时刻、或用户上次手动切号的时刻），
 * 并**每次成功切换后刷新** —— 否则用户刚手动切完，1 分钟后又被自动切走。
 * 没有起点（≤ 0）时**不切**：宁可不动，也不要在不知道"已经用了多久"的情况下贸然换号。
 */
export function isSwitchDue(minutes: number, lastSwitchAt: number, now: number): boolean {
  if (!Number.isFinite(minutes) || minutes <= 0) return false
  if (!Number.isFinite(lastSwitchAt) || lastSwitchAt <= 0) return false
  return now - lastSwitchAt >= minutes * 60_000
}

/**
 * 「刚被限流 ⇒ 可以换号」这条路径的判据。
 *
 * 🔴 这个函数是**单一来源**：`decideAutoSwitch`（决定重发时到底换不换）与宿主的
 * `canFailover`（决定失败时给短退避还是长退避）**必须**都走它，否则会出现最难查的一类故障 ——
 * **给了短退避让重试快点发生，而重发时其实并不换号** ⇒ 更快地撞同一个限流，比不给短退避还糟。
 *
 * 三个条件缺一不可：被限流过、还在"有用"的窗口里、距上次换号已过冷却期。
 */
export function isThrottleSwitchAllowed(params: {
  /** 该账号最近一次被限流的时刻（0 / undefined = 没被限流过）。 */
  throttledAt?: number
  /** 上一次换号（自动或手动）的时刻。 */
  lastSwitchAt: number
  now: number
  windowMs?: number
  cooldownMs?: number
}): boolean {
  const { throttledAt, lastSwitchAt, now } = params
  const windowMs = params.windowMs ?? THROTTLE_SWITCH_WINDOW_MS
  const cooldownMs = params.cooldownMs ?? THROTTLE_SWITCH_COOLDOWN_MS
  if (!Number.isFinite(throttledAt) || !throttledAt || throttledAt <= 0) return false
  // 限流发生在很久以前 ⇒ 多半早恢复了，不值得为它多换一次号（换号要付全量重发的代价）
  if (now - throttledAt > windowMs) return false
  // 刚换过号 ⇒ 冷却期内不换。否则"每个号都被限流"时会一路换下去 ——
  // 那正是我们最想避免的形态（同一出口 IP 上多号快速交替）。
  // ⚠️ 没有起点（≤ 0）时不套冷却：限流是明确的坏状态，比"不知道已经用了多久"更值得处理。
  if (Number.isFinite(lastSwitchAt) && lastSwitchAt > 0 && now - lastSwitchAt < cooldownMs) return false
  return true
}

/**
 * 从「各账号被限流的时刻」里，筛出**还在窗口内**的那些 id（含当前账号）。
 *
 * 用途有两个：① 判断当前账号是不是"刚被限流"；② 把它当作**排除项**传给 `pickNextAccount`,
 * 免得切到一个同样刚被限流的号 —— 那会白搭一轮全量重发（换号的代价本来就不小）。
 */
export function freshThrottledIds(
  throttledAt: ReadonlyMap<string, number> | undefined,
  now: number,
  windowMs = THROTTLE_SWITCH_WINDOW_MS,
): Set<string> {
  const fresh = new Set<string>()
  if (!throttledAt) return fresh
  for (const [id, at] of throttledAt) {
    if (Number.isFinite(at) && at > 0 && now - at <= windowMs) fresh.add(id)
  }
  return fresh
}

/**
 * 挑下一个可切换的账号。
 *
 * 规则：先滤掉不可用的，再取**当前账号之后的第一个**（走到末尾绕回开头）。
 *
 * 为什么是"当前账号的下一个"而不是"每次都取第一个可用的"：
 *   后者会让列表里的第二个账号成为唯一被切到的目标，其余永远不动 —— 那还是集中，不是分散。
 *
 * 边界：
 *   - 一个可用的都没有 ⇒ undefined（不切）
 *   - 当前账号自己不可用（失效/受限）⇒ 取第一个可用的（这是"救急"路径，本来就该切走）
 *   - 可用的只有当前这一个 ⇒ undefined（切了还是它，没意义）
 *
 * `excludeIds`：本轮**不该切过去**的账号（用在"刚被限流"上 —— 切到一个同样发不出请求的号，
 * 只会白搭一轮全量重发）。当前账号若在被排除之列，`findIndex` 返回 -1 ⇒ 取第一个可用的，
 * 正好也是"救急"该做的。
 */
export function pickNextAccount(
  accounts: readonly SwitchableAccount[],
  currentId: string | undefined,
  now: number,
  excludeIds?: ReadonlySet<string>,
): string | undefined {
  const usable = accounts.filter((account) => isUsable(account, now) && !excludeIds?.has(account.id))
  if (usable.length === 0) return undefined
  const index = usable.findIndex((account) => account.id === currentId)
  if (index < 0) return usable[0]?.id
  if (usable.length === 1) return undefined
  return usable[(index + 1) % usable.length]?.id
}

/**
 * 「这次失败能不能靠**换个号**接着干」—— `canFailover` 的纯判据（宿主三种 kind 共用同一条）。
 *
 * 抽出来是为了能单测：`canFailover` 本身是 `apply()` 里的闭包，拿不到；而这条判据正是
 * 「自动换号没生效」类故障最该被守住的地方（0.6.8 的实测现场：凭证被服务端作废，
 * 报 AUTH 之后一直不换号）。
 *
 * 三条边界都实测踩过：
 *  - 自动换号关着（`minutes <= 0`）⇒ **不是**能换号（默认关闭的语义就是"别偷偷把我换到别的号上"）。
 *  - 正在切换 ⇒ 不是（别叠加）。
 *  - 候选里没有**别的**可用账号 ⇒ 不是（切了还是自己，白等一轮）。
 */
export function hasFailoverCandidate(params: {
  minutes: number
  switching: boolean
  accounts: readonly SwitchableAccount[]
  currentId: string | undefined
  now: number
  excludeIds?: ReadonlySet<string>
}): boolean {
  if (!Number.isFinite(params.minutes) || params.minutes <= 0) return false
  if (params.switching) return false
  return pickNextAccount(params.accounts, params.currentId, params.now, params.excludeIds) !== undefined
}

/** 决策结果 —— 带 reason 是为了让日志能说清"这次为什么没切/为什么切"。 */
export type AutoSwitchDecision =
  | {
      action: 'switch'
      nextId: string
      reason: 'due' | 'current-unusable' | 'recently-throttled'
    }
  | {
      action: 'skip'
      reason: 'off' | 'not-due' | 'no-candidate' | 'no-other-account'
    }

/**
 * 把上面的判断合成一次决策。三条切号路径，按优先级排：
 *
 * 1. **当前账号不可用**（失效 / 受限未解除）—— 例外优先，哪怕没到点也要切走：
 *    让用户在一个失效的账号上继续等满 N 分钟是没有意义的（每个请求都会失败）。
 * 2. **当前账号刚被限流**（`throttledAt`）—— 见 `isThrottleSwitchAllowed`：受窗口与冷却双重约束。
 * 3. **到点了**（`isSwitchDue`）—— 主路径，按时间均衡轮换。
 *
 * ⚠️ `throttledAt` 是**限流**（瞬时）而不是**封禁**（账号级状态）：封禁走 `limit` 字段、
 * 落在第 1 条上；限流不进账号记录，所以单独传进来。
 */
export function decideAutoSwitch(params: {
  minutes: number
  lastSwitchAt: number
  now: number
  accounts: readonly SwitchableAccount[]
  currentId: string | undefined
  /** 各账号最近一次被限流的时刻（不含当前账号也行 —— 但含它才能走第 2 条路径）。 */
  throttledAt?: ReadonlyMap<string, number>
  /**
   * 上一次**真正换过号**的时刻（0 / undefined = 本次启动还没换过）。
   *
   * 🔴 限流那条的冷却必须用它，**不能**用 `lastSwitchAt` —— 后者在宿主里被初始化成
   * "启动时刻"（`isSwitchDue` 要的是"从启动算起过了多久"）。拿它当"上次换号"会让
   * **每次重启之后都有一段"限流也不换号"的窗口**：实测 2026-09-27，插件 10:56:30 启动、
   * 10:57:54 撞限流，距"启动"仅 73 秒 < 冷却 3 分钟 ⇒ **被自己的冷却挡掉了**，
   * 用户看到的就是"依旧没有自动切换账号"。
   */
  lastSwitchedAt?: number
  throttleWindowMs?: number
  throttleCooldownMs?: number
}): AutoSwitchDecision {
  const { minutes, lastSwitchAt, now, accounts, currentId } = params
  if (!Number.isFinite(minutes) || minutes <= 0) return { action: 'skip', reason: 'off' }

  const fresh = freshThrottledIds(params.throttledAt, now, params.throttleWindowMs)
  const current = accounts.find((account) => account.id === currentId)
  const currentUnusable = current !== undefined && !isUsable(current, now)
  // 注意：当前账号**不在库里**（可能刚被移除）时不算 unusable —— 那种情况下
  // 让既有的"无账号 ⇒ 报错提示登录"路径去处理，别在这里悄悄换号。
  const throttleSwitch = isThrottleSwitchAllowed({
    throttledAt: currentId === undefined ? undefined : params.throttledAt?.get(currentId),
    // ⚠️ 传的是"上次**真正换过号**的时刻"，不是 `lastSwitchAt`（那个在宿主里被初始化成
    // 启动时刻，拿它算冷却会让每次重启后都有一段时间"限流也不换号"）。见参数注释。
    lastSwitchAt: params.lastSwitchedAt ?? 0,
    now,
    ...(params.throttleWindowMs === undefined ? {} : { windowMs: params.throttleWindowMs }),
    ...(params.throttleCooldownMs === undefined ? {} : { cooldownMs: params.throttleCooldownMs }),
  })
  if (!currentUnusable && !throttleSwitch && !isSwitchDue(minutes, lastSwitchAt, now)) {
    return { action: 'skip', reason: 'not-due' }
  }

  const nextId = pickNextAccount(accounts, currentId, now, fresh)
  if (!nextId) {
    const anyUsable = accounts.some((account) => isUsable(account, now) && !fresh.has(account.id))
    return { action: 'skip', reason: anyUsable ? 'no-other-account' : 'no-candidate' }
  }
  return {
    action: 'switch',
    nextId,
    reason: currentUnusable ? 'current-unusable' : throttleSwitch ? 'recently-throttled' : 'due',
  }
}
