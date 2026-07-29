/**
 * Smoke HTTP 客户端封装（global fetch）
 *
 * 关键防御：
 * - prod 环境禁止 POST/PUT/PATCH/DELETE，调用直接抛错
 * - prod 例外白名单（PROD_WRITE_ALLOWLIST）：登录接口属于"获取 token"的必要前置，
 *   不算业务写入，必须放行；其它任何 POST/PUT/PATCH/DELETE 在 prod 仍硬阻
 * - 自动注入 Authorization: Bearer <token>（如有）
 * - 超时 + 错误格式化为 HttpResponse
 *
 * 自测说明（在 services/api/scripts/smoke/README.md 也有记录）：
 *
 *   # 1. prod + POST /api/app/auth/login → 应放行（拿 token）
 *   pnpm smoke:prod -- --module=auth   # 应看到 admin 登录 PASS
 *
 *   # 2. prod + POST 其它路径 → 应被硬阻
 *   pnpm smoke:prod -- --module=rbac   # rbac 模块声明 readonly:false，runner 自动跳过
 *                                       # 即使强行进入，rbac 内 adminClient.post('/api/admin/roles', ...)
 *                                       # 仍会被 isProdWriteAllowed() 拦下抛错
 *
 *   # 3. 单元自测（不进 git）：
 *   node -e "
 *     import('./scripts/smoke/http.js').then(({ isProdWriteAllowed }) => {
 *       console.log('login allowed:', isProdWriteAllowed('POST', '/api/app/auth/login'))  // true
 *       console.log('roles allowed:', isProdWriteAllowed('POST', '/api/admin/roles'))      // false
 *       console.log('orders write allowed:', isProdWriteAllowed('PATCH', '/api/admin/orders/x')) // false
 *     })
 *   "
 */
import type { HttpClient, HttpResponse, SmokeEnv } from './types'
import { errorMessage } from './helpers/shape'

type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const WRITE_METHODS: Method[] = ['POST', 'PUT', 'PATCH', 'DELETE']

/**
 * prod 环境写动作白名单：仅这些路径在 prod 允许 POST/PUT/PATCH/DELETE。
 * 登录是"拿 token"的必要前置，不算业务写入。
 *
 * **添加任何路径前必须明确确认它不会修改业务数据**。
 */
const PROD_WRITE_ALLOWLIST: ReadonlyArray<{ method: Method; path: string }> = [
  { method: 'POST', path: '/api/app/auth/login' },
]

/**
 * 判断 prod 模式下某 method+path 是否允许。
 * 抽出为纯函数便于自测（见上方注释）。
 */
export function isProdWriteAllowed(method: Method, path: string): boolean {
  return PROD_WRITE_ALLOWLIST.some((rule) => rule.method === method && rule.path === path)
}

export function createHttp(env: SmokeEnv, token?: string): HttpClient {
  async function request<T = unknown>(method: Method, path: string, body?: unknown): Promise<HttpResponse<T>> {
    if (env.env === 'prod' && WRITE_METHODS.includes(method) && !isProdWriteAllowed(method, path)) {
      throw new Error(`prod 环境禁止 ${method} ${path}（这是 smoke 框架的硬保护）`)
    }
    const url = path.startsWith('http') ? path : env.baseUrl + path
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`

    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), env.timeoutMs)
    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      })
    } catch (e: unknown) {
      clearTimeout(timer)
      throw new Error(`HTTP ${method} ${url} 失败: ${errorMessage(e)}`)
    }
    clearTimeout(timer)

    let data: unknown = null
    if (method !== 'HEAD') {
      const text = await res.text()
      try { data = text ? JSON.parse(text) : null } catch { data = text }
    }
    return {
      status: res.status,
      ok: res.ok,
      body: data as T,
      headers: Object.fromEntries(res.headers.entries()),
    }
  }

  return {
    get:    (p)     => request('GET',    p),
    head:   (p)     => request('HEAD',   p),
    post:   (p, b)  => request('POST',   p, b),
    put:    (p, b)  => request('PUT',    p, b),
    patch:  (p, b)  => request('PATCH',  p, b),
    delete: (p)     => request('DELETE', p),
  }
}

/** 登录 + 返回 token，失败抛错 */
export async function login(env: SmokeEnv, account: string, password: string): Promise<string> {
  const http = createHttp(env)
  const r = await http.post<{ token?: string; error?: string }>('/api/app/auth/login', { account, password })
  if (!r.ok || !r.body?.token) {
    throw new Error(`登录失败 ${account}: status=${r.status} body=${JSON.stringify(r.body).slice(0, 200)}`)
  }
  return r.body.token
}
