/**
 * 浏览器代理传输层 —— 当官方 DSH 桌面端拿不到 `electron.net.fetch` 时，
 * 用系统里的 Edge/Chrome 进程当请求出口，让 TLS/HTTP2 指纹与真实浏览器一致。
 *
 * 机制：启动一个 headless 浏览器（独立 profile），通过 CDP 在页面上下文里调用 `fetch()`，
 * 请求实际从浏览器网络栈发出。响应通过 `Runtime.addBinding` 建立的回调分块传回 Node，
 * 再包装成标准 `Response`（含 ReadableStream）交给插件。
 *
 * 为什么不用 electron.net.fetch：官方 DSH 把插件跑成 ELECTRON_RUN_AS_NODE=1 的 Node 子进程，
 * require('electron') 拿不到 net.fetch。本模块是绕过这个限制的后备方案。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  buildBrowserArgs,
  CdpClient,
  findSystemBrowser as findSystemBrowserImpl,
  parseDevToolsActivePort,
  type BrowserCandidate,
} from './browser-login.ts'

/** 暴露给测试/诊断：找系统浏览器。 */
export const findSystemBrowser = findSystemBrowserImpl

const BINDING_NAME = '__dshBrowserTransportCallback'
const PROFILE_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'web-login', 'transport-profile')

interface TransportRequestState {
  resolveHeaders: (status: number, statusText: string, headers: Record<string, string>) => void
  rejectHeaders: (err: Error) => void
  controller?: ReadableStreamDefaultController<Uint8Array>
  streamStarted: boolean
}

interface BrowserTransportSession {
  browser: BrowserCandidate
  child: ChildProcess
  cdp: CdpClient
  cleanup: () => void
}

let activeSession: BrowserTransportSession | undefined
let launchPromise: Promise<BrowserTransportSession> | undefined
const requests = new Map<string, TransportRequestState>()

export function systemBrowserAvailable(): boolean {
  // 测试隔离：单测/CI 可以强制关闭浏览器代理，避免依赖本机浏览器。
  if (process.env.DSH_NO_BROWSER_TRANSPORT === '1') return false
  return findSystemBrowser() !== null
}

/** 等 profile 里的 DevToolsActivePort 出现并返回端口。 */
async function waitForTransportDebugPort(
  profileDir: string,
  child: ChildProcess,
  timeoutMs = 25_000,
): Promise<number | undefined> {
  const portFile = join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return undefined
    try {
      const port = parseDevToolsActivePort(readFileSync(portFile, 'utf8'))
      if (port) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
            signal: AbortSignal.timeout(2_000),
            redirect: 'error',
          })
          if (res.ok) return port
        } catch {}
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  return undefined
}

/** 找一个可用的 page target（we use about:blank）。 */
async function findPageTarget(port: number, timeoutMs = 20_000): Promise<any | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2_000),
      })
      const targets = (await res.json()) as any[]
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {}
    await new Promise((r) => setTimeout(r, 400))
  }
  return null
}

function handleBindingEvent(payload: string): void {
  let msg: any
  try {
    msg = JSON.parse(payload)
  } catch {
    return
  }
  const requestId = msg?.requestId
  if (!requestId) return
  const state = requests.get(requestId)
  if (!state) return

  switch (msg.type) {
    case 'headers': {
      if (state.streamStarted) return
      state.streamStarted = true
      state.resolveHeaders(msg.status ?? 200, msg.statusText ?? '', msg.headers ?? {})
      break
    }
    case 'chunk': {
      const arr = msg.chunk
      if (Array.isArray(arr) && state.controller) {
        try {
          state.controller.enqueue(new Uint8Array(arr))
        } catch {}
      }
      break
    }
    case 'done': {
      if (state.controller) {
        try {
          state.controller.close()
        } catch {}
      }
      requests.delete(requestId)
      break
    }
    case 'error': {
      if (state.controller) {
        try {
          state.controller.error(new Error(String(msg.error ?? '浏览器请求失败')))
        } catch {}
      }
      if (!state.streamStarted) {
        state.rejectHeaders(new Error(String(msg.error ?? '浏览器请求失败')))
      }
      requests.delete(requestId)
      break
    }
  }
}

export async function launchBrowserTransport(): Promise<BrowserTransportSession> {
  if (activeSession) return activeSession
  if (launchPromise) return launchPromise

  launchPromise = (async () => {
    const browser = findSystemBrowser()
    if (!browser) throw new Error('未找到 Edge/Chrome，无法启动浏览器代理传输层')

    try {
      if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true })
      mkdirSync(PROFILE_DIR, { recursive: true })
    } catch (error: any) {
      throw new Error(`清理 transport profile 失败：${error?.message ?? error}`)
    }

    const child = spawn(
      browser.path,
      [
        ...buildBrowserArgs(PROFILE_DIR, 'about:blank'),
        '--headless=new',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--allow-insecure-localhost',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
      {
        stdio: 'ignore',
        detached: false,
      },
    )

    let spawnError: Error | undefined
    child.on('error', (err) => {
      spawnError = err
    })
    await new Promise((r) => setTimeout(r, 300))
    if (spawnError) {
      try {
        child.kill()
      } catch {}
      throw new Error(`启动浏览器失败：${spawnError.message}`)
    }

    const port = await waitForTransportDebugPort(PROFILE_DIR, child)
    if (!port) {
      try {
        child.kill()
      } catch {}
      throw new Error('浏览器调试端口未就绪')
    }

    const page = await findPageTarget(port)
    if (!page) {
      try {
        child.kill()
      } catch {}
      throw new Error('浏览器里没有可用页面')
    }

    const cdp = new CdpClient(page.webSocketDebuggerUrl)
    try {
      await cdp.connect()
    } catch (error: any) {
      try {
        child.kill()
      } catch {}
      throw new Error(`连接 CDP 失败：${error?.message ?? error}`)
    }

    await cdp.send('Runtime.enable').catch(() => {})
    await cdp.send('Runtime.addBinding', { name: BINDING_NAME }).catch((error: any) => {
      throw new Error(`addBinding 失败：${error?.message ?? error}`)
    })

    cdp.onEvent((method, params) => {
      if (method === 'Runtime.bindingCalled' && params?.name === BINDING_NAME) {
        handleBindingEvent(String(params?.payload ?? ''))
      }
    })

    const cleanup = (): void => {
      try {
        cdp.close()
      } catch {}
      try {
        child.kill()
      } catch {}
      activeSession = undefined
      launchPromise = undefined
    }

    child.on('exit', cleanup)

    return { browser, child, cdp, cleanup }
  })()

  try {
    activeSession = await launchPromise
  } catch (error) {
    launchPromise = undefined
    throw error
  }
  launchPromise = undefined
  return activeSession
}

export async function shutdownBrowserTransport(): Promise<void> {
  activeSession?.cleanup()
  activeSession = undefined
  launchPromise = undefined
}

function bodyToPageInit(body: BodyInit | null | undefined): string {
  if (body === undefined || body === null) {
    return 'undefined'
  }
  if (typeof body === 'string') {
    return JSON.stringify(body)
  }
  if (body instanceof Uint8Array) {
    return `new Uint8Array(${JSON.stringify(Array.from(body))})`
  }
  if (body instanceof ArrayBuffer) {
    return `new Uint8Array(${JSON.stringify(Array.from(new Uint8Array(body)))})`
  }
  throw new Error('浏览器代理传输层暂不支持 Blob/FormData/ReadableStream 请求体')
}

export function createBrowserFetch(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const session = await launchBrowserTransport()

    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    const headers: Record<string, string> = {}
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          headers[key] = value
        })
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) headers[key] = value
      } else {
        for (const [key, value] of Object.entries(init.headers)) headers[key] = String(value)
      }
    }

    const bodyExpr = bodyToPageInit(init?.body)
    const requestId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

    // 先注册状态，再 evaluate；binding 事件可能在 evaluate 还没返回时就到了。
    const headersPromise = new Promise<Response>((resolve, reject) => {
      const state: TransportRequestState = {
        resolveHeaders: (status, statusText, respHeaders) => {
          const stream = new ReadableStream<Uint8Array>({
            start: (controller) => {
              state.controller = controller
            },
            cancel: () => {
              requests.delete(requestId)
            },
          })
          const resp = new Response(stream, {
            status,
            statusText,
            headers: respHeaders,
          })
          resolve(resp)
        },
        rejectHeaders: reject,
        streamStarted: false,
      }
      requests.set(requestId, state)
    })

    const expression = `
      (async () => {
        const requestId = ${JSON.stringify(requestId)};
        try {
          const init = {
            method: ${JSON.stringify(method)},
            headers: ${JSON.stringify(headers)},
            body: ${bodyExpr},
          };
          const requestInit = init.body === undefined
            ? { method: init.method, headers: init.headers }
            : init;
          const resp = await fetch(${JSON.stringify(url)}, requestInit);
          ${BINDING_NAME}(JSON.stringify({
            requestId,
            type: 'headers',
            status: resp.status,
            statusText: resp.statusText,
            headers: Object.fromEntries(resp.headers.entries()),
          }));
          const reader = resp.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              ${BINDING_NAME}(JSON.stringify({ requestId, type: 'done' }));
              break;
            }
            ${BINDING_NAME}(JSON.stringify({ requestId, type: 'chunk', chunk: Array.from(value) }));
          }
        } catch (error) {
          ${BINDING_NAME}(JSON.stringify({ requestId, type: 'error', error: String(error) }));
        }
      })()
    `

    session.cdp.send('Runtime.evaluate', { expression, awaitPromise: false, userGesture: true }).catch((error: any) => {
      const state = requests.get(requestId)
      if (state && !state.streamStarted) {
        state.rejectHeaders(new Error(`evaluate 失败：${error?.message ?? error}`))
        requests.delete(requestId)
      }
    })

    return await headersPromise
  }
}
