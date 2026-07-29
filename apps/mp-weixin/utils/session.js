/**
 * 用户会话管理 — 微信登录 → 服务端认证 → JWT
 * @date   2026-03-27
 */

const config = require('./config')

const USER_KEY = 'standard_xz_user'
const TOKEN_KEY = 'standard_xz_token'
const FAVORITES_KEY = 'standard_xz_favorites'
const USAGE_KEY = 'standard_xz_daily_usage'
const TOOL_ORDER_KEY = 'standard_xz_tool_order'

// ═══════════════════════════════════════
// 用户基础
// ═══════════════════════════════════════

function getUser() {
  try { return wx.getStorageSync(USER_KEY) || null } catch (e) { return null }
}

function setUser(user) {
  wx.setStorageSync(USER_KEY, user)
  return user
}

function getToken() {
  try { return wx.getStorageSync(TOKEN_KEY) || '' } catch (e) { return '' }
}

function setToken(token) {
  wx.setStorageSync(TOKEN_KEY, token)
}

function isLoggedIn() {
  return !!getUser() && !!getToken()
}

function logout() {
  try {
    wx.removeStorageSync(USER_KEY)
    wx.removeStorageSync(TOKEN_KEY)
  } catch (e) {}
}

// ═══════════════════════════════════════
// 会员等级  free | personal | pro
// ═══════════════════════════════════════

function getMemberTier() {
  const user = getUser()
  if (!user) return 'free'
  var tier = user.memberTier || 'free'
  if (tier !== 'free' && user.memberExpire) {
    var expireDate = new Date(user.memberExpire)
    if (expireDate.getTime() < Date.now()) return 'free' // 已过期
  }
  return tier
}

function setMemberTier(tier) {
  const user = getUser()
  if (user) {
    user.memberTier = tier
    const d = new Date()
    d.setFullYear(d.getFullYear() + 1)
    user.memberExpire = d.toISOString().slice(0, 10)
    setUser(user)
  }
}

function isPaid() {
  return ['personal', 'pro', 'enterprise'].includes(getMemberTier())
}

function isPro() {
  var tier = getMemberTier()
  return tier === 'pro' || tier === 'enterprise'
}

// ═══════════════════════════════════════
// 每日使用限额
// ═══════════════════════════════════════

function _getTodayUsage() {
  try {
    const data = wx.getStorageSync(USAGE_KEY) || {}
    const today = new Date().toISOString().slice(0, 10)
    if (data.date !== today) {
      return { date: today, counts: {} }
    }
    return data
  } catch (e) {
    return { date: new Date().toISOString().slice(0, 10), counts: {} }
  }
}

function _saveTodayUsage(usage) {
  wx.setStorageSync(USAGE_KEY, usage)
}

function canUseFeature(feature) {
  if (isPaid()) return true
  const usage = _getTodayUsage()
  return (usage.counts[feature] || 0) < 5
}

function consumeFeature(feature) {
  if (isPaid()) return
  const usage = _getTodayUsage()
  usage.counts[feature] = (usage.counts[feature] || 0) + 1
  _saveTodayUsage(usage)
}

function checkAndConsume(feature) {
  if (!isLoggedIn()) {
    wx.showModal({
      title: '需要登录',
      content: '该功能需要登录后使用，是否立即登录？',
      confirmText: '登录',
      success: function (res) {
        if (res.confirm) ensureLogin()
      }
    })
    return false
  }
  if (isPaid()) return true
  if (!canUseFeature(feature)) {
    wx.showModal({
      title: '今日免费次数已用完',
      content: '升级会员可无限使用该功能',
      confirmText: '查看会员',
      success: function (res) {
        if (res.confirm) wx.navigateTo({ url: '/pages/membership/index' })
      }
    })
    return false
  }
  consumeFeature(feature)
  return true
}

function getCompareReportAccess() {
  const tier = getMemberTier()
  if (tier === 'pro' || tier === 'enterprise') {
    return { allowed: true, needPay: false, remaining: -1 } // -1 = 不限次
  }
  if (tier === 'personal') {
    // 优先用缓存的 API 额度数据
    var cached = _getCachedCompareQuota()
    if (cached && cached.remaining !== undefined) {
      if (cached.remaining > 0) {
        return { allowed: true, needPay: false, remaining: cached.remaining }
      }
      return { allowed: false, needPay: false, remaining: 0 }
    }
    // fallback: 本地计数
    const user = getUser()
    const usedCompares = (user && user.yearlyCompareUsed) || 0
    const limit = (user && user.yearlyCompareLimit) || 10
    if (usedCompares < limit) {
      return { allowed: true, needPay: false, remaining: limit - usedCompares }
    }
    return { allowed: false, needPay: false, remaining: 0 }
  }
  return { allowed: false, needPay: false, remaining: 0 }
}

var COMPARE_QUOTA_KEY = 'standard_xz_compare_quota'

function _getCachedCompareQuota() {
  try { return wx.getStorageSync(COMPARE_QUOTA_KEY) || null } catch (e) { return null }
}

/**
 * 从 API 刷新全库比对额度（异步），缓存到本地
 */
function refreshCompareQuota(callback) {
  var config = require('./config')
  wx.request({
    url: config.API_BASE + '/api/app/compare/free-quota',
    method: 'GET',
    header: { 'Authorization': 'Bearer ' + getToken() },
    timeout: 10000,
    success: function (res) {
      if (res.statusCode === 200 && res.data) {
        var quota = { remaining: res.data.remaining, total: res.data.total, ts: Date.now() }
        wx.setStorageSync(COMPARE_QUOTA_KEY, quota)
        if (typeof callback === 'function') callback(quota)
      }
    }
  })
}

// ═══════════════════════════════════════
// 登录 — 微信登录 + 服务端认证
// ═══════════════════════════════════════

/**
 * 微信登录 → 服务端 wx-login → 拿到 JWT + user
 * @param {Function} callback - 登录成功回调
 * @returns {Promise<object>} user
 */
function ensureLogin(callback) {
  const currentUser = getUser()
  const currentToken = getToken()
  if (currentUser && currentToken) {
    if (typeof callback === 'function') callback(currentUser)
    return Promise.resolve(currentUser)
  }

  return new Promise((resolve, reject) => {
    wx.login({
      success: (loginRes) => {
        if (!loginRes.code) {
          reject(new Error('wx.login 未返回 code'))
          return
        }
        // 销售归因：若有 pendingSalesCode 则随 wx-login 上传，后端首次注册时奖励 7 天试用
        let pendingSalesCode = ''
        try { pendingSalesCode = wx.getStorageSync('pendingSalesCode') || '' } catch (_) {}
        wx.request({
          url: `${config.API_BASE}/api/app/auth/wx-login`,
          method: 'POST',
          data: pendingSalesCode ? { code: loginRes.code, salesCode: pendingSalesCode } : { code: loginRes.code },
          timeout: 15000,
          success: (resp) => {
            if (resp.statusCode !== 200 || !resp.data || !resp.data.token) {
              const msg = (resp.data && resp.data.error) || '登录失败'
              wx.showToast({ title: msg, icon: 'none' })
              reject(new Error(msg))
              return
            }
            const { token, user, membership } = resp.data
            // 合并会员信息到 user 对象
            if (membership && membership.plan) {
              user.memberTier = membership.plan.id || 'free'
              user.memberExpire = membership.endAt
            } else {
              user.memberTier = 'free'
            }
            setToken(token)
            setUser(user)

            // 销售归因：登录成功后清 pendingSalesCode（避免后续登录重复上传）
            try { wx.removeStorageSync('pendingSalesCode') } catch (_) {}

            // 营销自动化任务六 R14：登录成功后消费 pendingReferral（若有）
            try {
              var pendingScene = wx.getStorageSync('pendingReferral')
              if (pendingScene) {
                wx.request({
                  url: config.API_BASE + '/api/app/referral/track',
                  method: 'POST',
                  header: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
                  data: { scene: pendingScene },
                  timeout: 10000,
                  complete: function () {
                    // 无论成功/失败/已归属，都清掉 storage 避免反复调
                    try { wx.removeStorageSync('pendingReferral') } catch (e) {}
                  }
                })
              }
            } catch (e) { /* 静默：归因失败不阻塞登录 */ }

            if (typeof callback === 'function') callback(user)
            resolve(user)
          },
          fail: (err) => {
            wx.showToast({ title: '网络错误，请稍后重试', icon: 'none' })
            reject(err)
          }
        })
      },
      fail: reject
    })
  })
}

/**
 * 要求登录，未登录则弹窗引导
 */
function requireLogin(callback, silent) {
  if (isLoggedIn()) {
    if (typeof callback === 'function') callback(getUser())
    return true
  }
  if (silent) return false
  wx.showModal({
    title: '需要登录',
    content: '该功能需要登录后使用，是否立即登录？',
    confirmText: '登录',
    success: (res) => {
      if (res.confirm) {
        ensureLogin(callback)
      }
    }
  })
  return false
}

/**
 * 检查是否需要绑定手机号
 */
function needBindPhone() {
  const user = getUser()
  return user && !user.phone
}

// ═══════════════════════════════════════
// 收藏
// ═══════════════════════════════════════

function getFavorites() {
  try { return wx.getStorageSync(FAVORITES_KEY) || [] } catch (e) { return [] }
}

function setFavorites(ids) {
  wx.setStorageSync(FAVORITES_KEY, ids)
  return ids
}

function isFavorite(id) {
  return getFavorites().includes(id)
}

function toggleFavorite(id) {
  const favorites = getFavorites()
  const next = favorites.includes(id) ? favorites.filter(item => item !== id) : favorites.concat(id)
  setFavorites(next)
  return next
}

// ═══════════════════════════════════════
// 工具顺序
// ═══════════════════════════════════════

function getToolOrder() {
  try { return wx.getStorageSync(TOOL_ORDER_KEY) || null } catch (e) { return null }
}

function setToolOrder(order) {
  wx.setStorageSync(TOOL_ORDER_KEY, order)
}

// ═══════════════════════════════════════
// 用户信息后台刷新（onAppShow 入口）
// ═══════════════════════════════════════
//
// admin 改了用户的 role / membership / SalesProfile 后，小程序端 wx.storage 里
// 的 user 对象仍是旧值，依赖 user.role 的 UI 入口不会更新。
// onAppShow 时拉一次 /api/app/profile 合并到本地 storage，30s 节流避免频繁请求。

const USER_REFRESH_KEY = 'standard_xz_user_refresh_at'
const USER_REFRESH_THROTTLE_MS = 30 * 1000

function refreshUser(callback) {
  if (!isLoggedIn()) {
    if (typeof callback === 'function') callback(null)
    return
  }
  const now = Date.now()
  const last = wx.getStorageSync(USER_REFRESH_KEY) || 0
  if (now - last < USER_REFRESH_THROTTLE_MS) {
    if (typeof callback === 'function') callback(getUser())
    return
  }
  wx.setStorageSync(USER_REFRESH_KEY, now)
  wx.request({
    url: config.API_BASE + '/api/app/profile',
    method: 'GET',
    header: { Authorization: 'Bearer ' + getToken() },
    timeout: 10000,
    success: function (res) {
      if (res.statusCode === 200 && res.data && res.data.user) {
        const cached = getUser() || {}
        const fresh = res.data.user
        // 合并会员信息（与 pages/profile/index.js _refreshProfile 同逻辑）
        if (res.data.membership && res.data.membership.plan) {
          fresh.memberTier = res.data.membership.plan.id || 'free'
          fresh.memberExpire = res.data.membership.endAt
        } else {
          fresh.memberTier = cached.memberTier || 'free'
          fresh.memberExpire = cached.memberExpire
        }
        // 保留微信头像 / 昵称等本地字段
        if (!fresh.avatarUrl && cached.avatarUrl) fresh.avatarUrl = cached.avatarUrl
        if (!fresh.nickName && cached.nickName) fresh.nickName = cached.nickName
        setUser(fresh)
        if (typeof callback === 'function') callback(fresh)
      } else {
        if (typeof callback === 'function') callback(null)
      }
    },
    fail: function () {
      // 网络失败不重置节流戳，下次 onAppShow 仍走节流（避免循环重试）
      if (typeof callback === 'function') callback(null)
    }
  })
}

module.exports = {
  getUser, setUser, getToken, setToken, isLoggedIn, ensureLogin, requireLogin, logout,
  needBindPhone,
  getMemberTier, setMemberTier, isPaid, isPro,
  canUseFeature, consumeFeature, checkAndConsume, getCompareReportAccess, refreshCompareQuota,
  getFavorites, setFavorites, isFavorite, toggleFavorite,
  getToolOrder, setToolOrder,
  refreshUser
}
