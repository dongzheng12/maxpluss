/**
 * Smoke 框架共享类型
 */

export type SmokeEnvName = 'local' | 'preprod' | 'prod'

export interface SmokeEnv {
  env: SmokeEnvName
  baseUrl: string
  allowWrites: boolean
  adminPhone: string
  adminPassword: string
  salesPhone: string
  salesPassword: string
  userPhone: string
  userPassword: string
  cleanupPrefix: string  // 例 "SMOKE_LOCAL_1715000000_"
  timeoutMs: number
  verbose: boolean
}

export interface HttpResponse<T = unknown> {
  status: number
  ok: boolean
  body: T
  headers?: Record<string, string>
}

export interface HttpClient {
  get<T = unknown>(path: string): Promise<HttpResponse<T>>
  head<T = unknown>(path: string): Promise<HttpResponse<T>>
  post<T = unknown>(path: string, body?: unknown): Promise<HttpResponse<T>>
  put<T = unknown>(path: string, body?: unknown): Promise<HttpResponse<T>>
  patch<T = unknown>(path: string, body?: unknown): Promise<HttpResponse<T>>
  delete<T = unknown>(path: string): Promise<HttpResponse<T>>
}

export interface SmokeContext {
  env: SmokeEnv
  /** 创建一个带 token 的 client；不传 token = 匿名 */
  http(token?: string): HttpClient
}

export interface SmokeResult {
  module: string
  test: string
  ok: boolean
  status?: number
  error?: string
  durationMs: number
}

export interface SmokeModuleMeta {
  name: string
  /** prod 环境只跑 readonly=true 的模块；非 readonly 的 module 不能在 prod 跑 */
  readonly: boolean
}

export type SmokeModuleFn = (ctx: SmokeContext) => Promise<SmokeResult[]>
