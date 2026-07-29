/**
 * 裂变归因辅助（PC Web）
 *
 * 与小程序端 wx.getStorageSync('pendingReferral') 对称：
 *  - 用户访问任意页面，URL 含 ?ref=<code> → 写入 localStorage
 *  - 登录 / 注册成功后调 consumePendingReferral() → 向后端 POST /referral/track
 *    → 清除 storage（无论成功/失败，避免反复调）
 */
import { trackReferral } from '../api/app'

const STORAGE_KEY = 'bxz_pending_referral'

/** 从 URL 捕获 ?ref=<code> 写 localStorage；早期在 App 根部调一次即可 */
export function captureReferralFromUrl(): void {
  try {
    const params = new URLSearchParams(window.location.search)
    const ref = params.get('ref')
    if (ref && ref.length > 0 && ref.length <= 64) {
      // 已存过不覆盖：先到先得
      if (!localStorage.getItem(STORAGE_KEY)) {
        localStorage.setItem(STORAGE_KEY, ref)
      }
    }
  } catch { /* 静默 */ }
}

/** 登录/注册成功后调：有 pendingReferral 则上报归因，之后无论结果清 storage */
export function consumePendingReferral(): void {
  let code: string | null = null
  try { code = localStorage.getItem(STORAGE_KEY) } catch { /* ignore */ }
  if (!code) return
  trackReferral(`ref_${code}`)
    .catch(() => { /* 静默：归因失败不阻塞主流程 */ })
    .finally(() => {
      try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
    })
}
