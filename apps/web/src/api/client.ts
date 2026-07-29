import axios from 'axios'

// 开发环境走 Vite 代理（/node-api → localhost:3000, /py-api → api.biaozhunxiaozhi.com）
// 生产环境直接走同域 nginx 反代（/api/ → 3000, /api/v1/ → 8066）
const isDev = import.meta.env.DEV

// Node.js API (user/order/compare/admin)
// withCredentials: 让 axios 自动携带浏览器 origin 凭证（含 Basic Auth、cookie），
// 否则同源 XHR 不会复用浏览器为 origin 缓存的 Basic Auth 凭证 —— 在 8083 pre-prod
// 这种走 nginx Basic Auth 的入口下，所有 axios 请求会被 nginx 401。
// 生产同源场景下无副作用（不触发 CORS preflight）。
export const nodeApi = axios.create({
  baseURL: isDev ? '/node-api' : '',
  timeout: 30000,
  withCredentials: true,
})

// Python API (standards search/knowledge engine)
export const pyApi = axios.create({
  baseURL: isDev ? '/py-api' : '',
  timeout: 30000,
  withCredentials: true,
})

// 简易去重:同一窗口期连续 401(被拦截器多次触发)只弹一次 toast,
// 避免一个页面发多个 401 导致刷屏。3 秒静默窗。
let _lastAuthExpiredToastAt = 0
function notifyAuthExpired() {
  localStorage.removeItem('bxz_token')
  localStorage.removeItem('bxz_user')
  localStorage.removeItem('bxz_user_id')
  window.dispatchEvent(new CustomEvent('bxz-auth-expired'))
  const now = Date.now()
  if (now - _lastAuthExpiredToastAt > 3000) {
    _lastAuthExpiredToastAt = now
    import('antd').then(({ message }) => message.warning('登录已过期，请重新登录'))
  }
}

// Request interceptor — attach auth token
nodeApi.interceptors.request.use((cfg) => {
  const token = localStorage.getItem('bxz_token')
  if (token) cfg.headers.Authorization = `Bearer ${token}`
  const uid = localStorage.getItem('bxz_user_id')
  if (uid) cfg.headers['x-user-id'] = uid
  return cfg
})

// 走远端代理的路径前缀（本地 token 对远端无效，401 不应清登录态）。
// compare/tasks 在 vite.config.ts 中优先走本地，因此这里不纳入远端豁免。
const REMOTE_PREFIXES = ['/api/app/compare/upload-part', '/api/app/compare/library', '/api/app/compare/extract-sections', '/api/app/compare/run-sections', '/api/app/recognize']

// Response interceptor — unwrap data；仅本地 API 的 401 清登录态；网络错误全局兜底
nodeApi.interceptors.response.use(
  (r) => r.data,
  (e) => {
    if (import.meta.env.DEV) {
      console.error('[nodeApi]', e?.response?.status, e?.message)
    }
    if (e?.response?.status === 401) {
      const url = e?.config?.url || ''
      const isRemote = REMOTE_PREFIXES.some(p => url.startsWith(p))
      if (!isRemote) {
        notifyAuthExpired()
      }
    }
    // 网络断开（无 response）全局提示
    if (!e?.response && e?.message !== 'canceled') {
      import('antd').then(({ message }) => message.error('网络连接失败，请检查网络'))
    }
    return Promise.reject(e)
  },
)
pyApi.interceptors.response.use(
  (r) => r.data,
  (e) => {
    if (import.meta.env.DEV) {
      console.error('[pyApi]', e?.response?.status, e?.message)
    }
    if (e?.response?.status === 401) {
      notifyAuthExpired()
    }
    if (!e?.response && e?.message !== 'canceled') {
      import('antd').then(({ message }) => message.error('网络连接失败，请检查网络'))
    }
    return Promise.reject(e)
  },
)
