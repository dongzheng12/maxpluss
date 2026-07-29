/**
 * 统一请求封装 — 自动注入 Authorization header
 * 用法：const request = require('../../utils/request')
 *       request({ url: '/api/app/home', ... })
 */
const config = require('./config')
const session = require('./session')

const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_RETRY_DELAY_MS = 800
const DEFAULT_RETRY_MAX_DELAY_MS = 5000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getRetryDelay(options, attempt) {
  const base = Number(options.retryDelay || DEFAULT_RETRY_DELAY_MS)
  const max = Number(options.retryMaxDelay || DEFAULT_RETRY_MAX_DELAY_MS)
  const raw = Math.min(max, base * Math.pow(2, attempt))
  const jitter = Math.floor(Math.random() * Math.min(250, Math.max(1, Math.floor(raw / 3))))
  return raw + jitter
}

function isRetriableStatus(statusCode) {
  return statusCode === 408 || statusCode === 429 || statusCode >= 500
}

function buildRequestContext(options) {
  const token = session.getToken()
  const user = session.getUser()
  const header = { ...(options.header || {}) }

  if (token) {
    header['Authorization'] = `Bearer ${token}`
  }
  if (user && user.id) {
    header['x-user-id'] = user.id
  }

  const fullUrl = options.url.startsWith('http')
    ? options.url
    : `${config.API_BASE}${options.url}`

  return { fullUrl, header }
}

function requestOnce(options, context) {
  return new Promise((resolve, reject) => {
    wx.request({
      ...options,
      url: context.fullUrl,
      header: context.header,
      timeout: options.timeout || DEFAULT_TIMEOUT_MS,
      success: (res) => {
        // 401 → token 过期，清登录态；不重试，避免登录页循环跳转。
        if (res.statusCode === 401) {
          session.logout()
          wx.showToast({ title: '登录已过期，请重新登录', icon: 'none' })
          setTimeout(() => {
            wx.reLaunch({ url: '/pages/profile/index' })
          }, 1500)
          const err = new Error('Unauthorized')
          err.nonRetriable = true
          reject(err)
          return
        }
        resolve(res)
      },
      fail: (err) => {
        reject(err)
      }
    })
  })
}

function request(options) {
  const context = buildRequestContext(options)
  const retry = Math.max(0, Number(options.retry || 0))

  function run(attempt) {
    return requestOnce(options, context).then((res) => {
      if (attempt < retry && isRetriableStatus(res.statusCode)) {
        return sleep(getRetryDelay(options, attempt)).then(() => run(attempt + 1))
      }
      if (options.success) options.success(res)
      if (options.complete) options.complete(res)
      return res
    }).catch((err) => {
      if (attempt < retry && !err.nonRetriable) {
        return sleep(getRetryDelay(options, attempt)).then(() => run(attempt + 1))
      }
      if (options.fail) options.fail(err)
      if (options.complete) options.complete(err)
      throw err
    })
  }

  return run(0)
}

module.exports = request
