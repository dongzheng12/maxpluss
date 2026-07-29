const session = require('./utils/session')
const { track } = require('./utils/tracker')
const remoteConfig = require('./utils/remoteConfig')

App({
  onLaunch(options) {
    this.globalData.user = session.getUser()
    const isReturning = !!session.getUser()
    track('session_start', {
      is_returning: isReturning,
      scene: options && options.scene,
    })

    // 异步拉远程配置（不阻塞首屏，失败完全静默 — 页面用 fallback 字面值）
    remoteConfig.loadRemoteConfig()

    // 营销自动化任务六 R14：解析带参小程序码 scene
    // 带参小程序码 scene 格式：ref_<inviterId>
    // 微信把 scene 通过 query.scene 传入（且可能被 URL encode），需 decode
    try {
      const rawScene = options && options.query && options.query.scene
      if (rawScene) {
        const scene = decodeURIComponent(rawScene)
        if (scene.indexOf('ref_') === 0) {
          wx.setStorageSync('pendingReferral', scene)
        }
      }
    } catch (e) { /* scene 异常不阻塞启动 */ }
  },
  onShow() {
    // 切回前台时刷一次用户信息（含 role / membership / SalesProfile），
    // 缓解 admin 后台改角色后小程序端 storage 旧值不更新问题。
    // session.refreshUser() 内部 30s 节流，未登录态自动跳过。
    try { session.refreshUser() } catch (e) { /* 静默 */ }
  },
  onHide() {
    track('session_end', {})
  },
  globalData: {
    icsSelection: null,
    pendingKeyword: '',
    pendingCategory: 'all',
    pendingCommitteeId: '',
    pendingIndustryKey: '',
    user: null
  }
})
