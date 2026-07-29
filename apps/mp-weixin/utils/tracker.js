/**
 * 小程序端埋点 SDK
 * 静默上报，失败不影响主流程
 */
const { API_BASE } = require('./config')
const { getSession } = require('./session')

const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36)

function track(event, props) {
  try {
    const { token, user } = getSession()
    wx.request({
      url: `${API_BASE}/api/app/track`,
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      data: {
        event,
        props: props || {},
        platform: 'mp',
        ts: Date.now(),
        sessionId,
        userId: (user && user.id) || null,
      },
      timeout: 3000,
      fail: () => {},
    })
  } catch (e) {
    // 静默
  }
}

function trackPageView(page) {
  track('page_view', { page })
}

module.exports = { track, trackPageView }
