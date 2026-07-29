/**
 * 小程序远程配置消费工具（C2）
 *
 * 职责：
 *   - onLaunch 拉一次 /api/app/config，存 wx.storage 缓存
 *   - 提供 getCopy/getContact/getShare/getFlag 同步读取（兜底）
 *   - 三层兜底：内存 → wx.storage → 调用方传入 fallback
 *
 * 不做的事：
 *   - 不做强制刷新（页面级 setData 时直接读取，缺则走 fallback）
 *   - 不阻塞首屏（拉取失败完全静默，页面 fallback 即提审版本字面值）
 *
 * 提审约束：
 *   每一处 getCopy/getContact/getShare 调用必须传入 fallback，
 *   且 fallback 字面值必须与 wxml/js 显示文案完全一致。
 *   接口正常和接口失败时，用户可见文案应当一致。
 */
const config = require('./config')
const {
  isMembershipBenefitsMatrix,
} = require('./membershipBenefitsMatrix')

const STORAGE_KEY = 'app_config_v1'
const CONFIG_TIMEOUT_MS = 5000
const CONFIG_PATH = '/api/app/config'
const PRICING_PATH = '/api/app/pricing'

let memCache = null

function readStorage() {
  try {
    const raw = wx.getStorageSync(STORAGE_KEY)
    if (raw && typeof raw === 'object') return raw
  } catch (_) {}
  return null
}

function writeStorage(data) {
  try { wx.setStorageSync(STORAGE_KEY, data) } catch (_) {}
}

/** 启动时调用，不阻塞、失败静默 */
function loadRemoteConfig() {
  // 先用 storage 暖启动
  const cached = readStorage()
  if (cached) memCache = cached

  return new Promise((resolve) => {
    wx.request({
      url: config.API_BASE + CONFIG_PATH,
      method: 'GET',
      timeout: CONFIG_TIMEOUT_MS,
      success: (res) => {
        if (res && res.statusCode === 200 && res.data && typeof res.data === 'object') {
          memCache = res.data
          writeStorage(res.data)
        }
        resolve(memCache)
      },
      fail: () => resolve(memCache),
    })
  })
}

/** 进入支付/会员页前同步刷一次 pricing（独立缓存，60s TTL 由后端控） */
function loadPricing() {
  return new Promise((resolve) => {
    wx.request({
      url: config.API_BASE + PRICING_PATH,
      method: 'GET',
      timeout: CONFIG_TIMEOUT_MS,
      success: (res) => {
        if (res && res.statusCode === 200 && res.data && Array.isArray(res.data.plans)) {
          resolve(res.data)
          return
        }
        resolve(null)
      },
      fail: () => resolve(null),
    })
  })
}

function getCopy(page, key, fallback) {
  if (typeof fallback !== 'string') {
    throw new Error('[remoteConfig] getCopy 必须传入 string fallback（提审一致性守卫）')
  }
  const c = memCache && memCache.copy && memCache.copy[page]
  if (c && typeof c[key] === 'string' && c[key].length > 0) return c[key]
  return fallback
}

function getContact(key, fallback) {
  if (typeof fallback !== 'string') {
    throw new Error('[remoteConfig] getContact 必须传入 string fallback')
  }
  const c = memCache && memCache.contact
  if (c && typeof c[key] === 'string' && c[key].length > 0) return c[key]
  return fallback
}

function getShare(key, fallback) {
  if (typeof fallback !== 'string') {
    throw new Error('[remoteConfig] getShare 必须传入 string fallback')
  }
  const s = memCache && memCache.share
  if (s && typeof s[key] === 'string' && s[key].length > 0) return s[key]
  return fallback
}

function getFlag(key, defaultValue) {
  const f = memCache && memCache.flags
  if (f && Object.prototype.hasOwnProperty.call(f, key)) return f[key]
  return defaultValue
}

function getMembershipBenefitsMatrix(fallback) {
  const matrix = memCache && memCache.membershipBenefitsMatrix
  if (isMembershipBenefitsMatrix(matrix)) return matrix
  return fallback
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(function (item) { return typeof item === 'string' })
}

function isCompareMembershipNotice(value) {
  if (!value || typeof value !== 'object') return false
  var launch = value.launch
  var result = value.result
  return launch && typeof launch === 'object' &&
    result && typeof result === 'object' &&
    typeof launch.free === 'string' &&
    typeof launch.personalRemaining === 'string' &&
    typeof launch.personalExhausted === 'string' &&
    typeof launch.pro === 'string' &&
    typeof launch.pairPageLimit === 'string' &&
    typeof launch.pairMemberOnly === 'string' &&
    typeof result.free === 'string' &&
    typeof result.personalRemaining === 'string' &&
    typeof result.personalExhausted === 'string' &&
    typeof result.pro === 'string' &&
    typeof result.reportLocked === 'string'
}

function readTextField(field, fallback) {
  if (typeof fallback !== 'string') {
    throw new Error('[remoteConfig] text fallback 必须传入 string')
  }
  if (memCache && typeof memCache[field] === 'string' && memCache[field].length > 0) return memCache[field]
  return fallback
}

function getMemberFreeBenefits(fallback) {
  var value = memCache && memCache.memberFreeBenefits
  if (isStringArray(value)) return value
  return fallback
}

function getMembershipInfoNotice(fallback) {
  return readTextField('membershipInfoNotice', fallback)
}

function getCompareMembershipNotice(fallback) {
  var value = memCache && memCache.compareMembershipNotice
  if (isCompareMembershipNotice(value)) return value
  return fallback
}

function getProfileLoginHint(fallback) {
  return readTextField('profileLoginHint', fallback)
}

function getProfileMembershipHint(fallback) {
  return readTextField('profileMembershipHint', fallback)
}

module.exports = {
  loadRemoteConfig,
  loadPricing,
  getCopy,
  getContact,
  getShare,
  getFlag,
  getMembershipBenefitsMatrix,
  getMemberFreeBenefits,
  getMembershipInfoNotice,
  getCompareMembershipNotice,
  getProfileLoginHint,
  getProfileMembershipHint,
}
