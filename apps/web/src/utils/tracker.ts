/**
 * PC Web 端埋点 SDK
 * 使用 navigator.sendBeacon 上报，不阻塞页面
 */

const sessionId = typeof crypto !== 'undefined' && crypto.randomUUID
  ? crypto.randomUUID()
  : Math.random().toString(36).slice(2) + Date.now().toString(36)

let disabledForSession = false

function getCurrentUserId(): string | null {
  return localStorage.getItem('bxz_user_id') || null
}

function getToken(): string | null {
  return localStorage.getItem('bxz_token') || null
}

export function track(event: string, props: Record<string, unknown> = {}): void {
  try {
    if (disabledForSession) return
    const payload = {
      event,
      props,
      platform: 'pc',
      ts: Date.now(),
      sessionId,
      userId: getCurrentUserId(),
    }
    const token = getToken()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`

    // sendBeacon 不支持自定义 header，所以用 fetch + keepalive
    // dev 走 vite proxy /node-api → localhost:3000；prod 同域 /api 走 nginx 反代
    // credentials:'include' 让 fetch 在同源场景也显式携带浏览器凭证（Basic Auth / cookie），
    // 否则 8083 pre-prod 走 nginx Basic Auth 时 fetch 默认 'same-origin' 不传 → 401。
    // 同源生产无副作用（同源不触发 CORS preflight）。
    const trackUrl = import.meta.env.DEV ? '/node-api/api/app/track' : '/api/app/track'
    fetch(trackUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      credentials: 'include',
      keepalive: true,
    }).then((res) => {
      if (!res.ok) disabledForSession = true
    }).catch(() => {
      disabledForSession = true
    })
  } catch {
    // 埋点失败静默
  }
}

/**
 * 页面浏览埋点 — 在路由变化时调用
 */
export function trackPageView(page: string): void {
  track('page_view', { page })
}

/**
 * 落地页到达 — 解析 URL UTM 参数
 */
export function trackLandingArrive(): void {
  const params = new URLSearchParams(window.location.search)
  const utm: Record<string, string> = {}
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign']) {
    const val = params.get(key)
    if (val) utm[key.replace('utm_', '')] = val
  }
  track('landing_arrive', {
    referrer: document.referrer || null,
    ...utm,
  })
}
