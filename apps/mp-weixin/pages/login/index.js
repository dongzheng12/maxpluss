/**
 * 小程序登录页 — 个人版（手机号+密码 / 微信一键）/ 企业版（跳申请页）
 * - 个人版默认手机号 + 密码登录（与 PC Web 一致）；微信一键作为辅助入口
 * - 立即注册 → 跳现有 register 销售/注册页（后续专项处理）
 * - 忘记密码 → 小程序暂无找回密码页，toast 引导走网页版
 */
const session = require('../../utils/session')
const config = require('../../utils/config')
// 注：login 页 onPasswordLogin 绕过 utils/request（拦截器对 401 会自动 reLaunch profile +
// toast「登录已过期」），直接用 wx.request 自己分级处理 200 / 404 / 401 / 其他

Page({
  data: {
    activeTab: 'personal', // personal | enterprise
    authing: false,
    statusBarHeight: 20,
    // 密码登录
    phone: '',
    password: '',
    loginingByPwd: false,
    // 企业版登录（已开通企业版的账号用手机号 + 密码登录）
    entPhone: '',
    entPassword: '',
    entLogining: false,
    // 协议勾选：默认未勾选，按钮置灰；勾选后方可点击。审核要求，不允许默认勾选。
    agreed: false,
  },

  toggleAgreed() {
    this.setData({ agreed: !this.data.agreed })
  },

  onLoad(options) {
    if (options && options.tab === 'enterprise') {
      this.setData({ activeTab: 'enterprise' })
    }
    // 销售归因：?salesCode= 透传到 storage，session.ensureLogin / 密码登录都会带上
    // 没带 salesCode 参数时主动清掉旧的 pendingSalesCode，避免历史 storage 误归因
    const salesCode = (options && options.salesCode) ? String(options.salesCode).trim() : ''
    if (!salesCode) {
      try { wx.removeStorageSync('pendingSalesCode') } catch (_) {}
    } else {
      try { wx.setStorageSync('pendingSalesCode', salesCode) } catch (_) {}
    }
    this.setData({ salesCode })

    // 自定义导航栏：取系统状态栏高度，避免 iOS 顶部内容被刘海/灵动岛遮挡
    try {
      const sys = wx.getSystemInfoSync()
      if (sys && sys.statusBarHeight) {
        this.setData({ statusBarHeight: sys.statusBarHeight + 16 })
      }
    } catch (_) { /* 静默 */ }
  },

  onShareAppMessage() {
    return { title: '标准小智 — 标准智能平台', path: '/pages/login/index' }
  },

  onShareTimeline() {
    return { title: '标准小智 — 标准智能平台' }
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab && tab !== this.data.activeTab) {
      this.setData({ activeTab: tab })
    }
  },

  // ─── 手机号 + 密码登录 ─────────────────────────────────────

  onPhoneInput(e) {
    this.setData({ phone: e.detail.value.trim() })
  },

  onPasswordInput(e) {
    this.setData({ password: e.detail.value })
  },

  onPasswordLogin() {
    if (this.data.loginingByPwd) return
    if (!this.data.agreed) {
      return wx.showToast({ title: '请先阅读并同意用户协议', icon: 'none' })
    }
    const { phone, password } = this.data
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      return wx.showToast({ title: '请输入有效手机号', icon: 'none' })
    }
    if (!password) {
      return wx.showToast({ title: '请输入密码', icon: 'none' })
    }

    this.setData({ loginingByPwd: true })
    wx.request({
      url: `${config.API_BASE}/api/app/auth/login`,
      method: 'POST',
      data: { account: phone, password },
      timeout: 15000,
      success: (res) => {
        const code = res.statusCode
        if (code === 200 && res.data && res.data.token && res.data.user) {
          const user = res.data.user
          if (res.data.membership && res.data.membership.plan) {
            user.memberTier = res.data.membership.plan.id || 'free'
            user.memberExpire = res.data.membership.endAt
          } else {
            user.memberTier = 'free'
          }
          session.setToken(res.data.token)
          session.setUser(user)
          // 已登录用户清销售归因 storage（归因在 register 阶段处理）
          try { wx.removeStorageSync('pendingSalesCode') } catch (_) {}

          wx.showToast({ title: '登录成功', icon: 'success' })
          setTimeout(() => {
            wx.reLaunch({ url: '/pages/home/index' })
          }, 500)
          return
        }
        // 404 / 401 / 其他错误分级
        const msg = code === 404
          ? '该账号未注册，请前往网页版注册'
          : (res.data && res.data.error) || '登录失败，请检查账号和密码'
        wx.showToast({ title: msg, icon: 'none', duration: 3000 })
        this.setData({ loginingByPwd: false })
      },
      fail: () => {
        wx.showToast({ title: '网络错误，请重试', icon: 'none' })
        this.setData({ loginingByPwd: false })
      },
    })
  },

  // ─── 企业版登录（手机号 + 密码 → 按 enterpriseRole 路由）──────

  onEntPhoneInput(e) {
    this.setData({ entPhone: e.detail.value.trim() })
  },

  onEntPasswordInput(e) {
    this.setData({ entPassword: e.detail.value })
  },

  onEnterpriseLogin() {
    if (this.data.entLogining) return
    if (!this.data.agreed) {
      return wx.showToast({ title: '请先阅读并同意用户协议', icon: 'none' })
    }
    const { entPhone, entPassword } = this.data
    if (!/^1[3-9]\d{9}$/.test(entPhone)) {
      return wx.showToast({ title: '请输入有效手机号', icon: 'none' })
    }
    if (!entPassword) {
      return wx.showToast({ title: '请输入密码', icon: 'none' })
    }

    this.setData({ entLogining: true })
    wx.request({
      url: `${config.API_BASE}/api/app/auth/login`,
      method: 'POST',
      data: { account: entPhone, password: entPassword },
      timeout: 15000,
      success: (res) => {
        const code = res.statusCode
        if (code === 200 && res.data && res.data.token && res.data.user) {
          const user = res.data.user
          const token = res.data.token
          session.setToken(token)
          wx.request({
            url: `${config.API_BASE}/api/enterprise/me`,
            method: 'GET',
            header: { Authorization: `Bearer ${token}` },
            timeout: 15000,
            success: (meRes) => {
              const me = meRes.data || {}
              const role = me.enterpriseRole || user.enterpriseRole || ''
              const enterpriseId = me.enterpriseId || user.enterpriseId || ''
              const isAdminBypass = !!me.isAdminBypass
              const passwordMustChange = !!((me.user && me.user.passwordMustChange) || user.passwordMustChange)
              if (meRes.statusCode !== 200 || (!isAdminBypass && (!enterpriseId || !role))) {
                session.logout()
                this.setData({ entLogining: false })
                return wx.showToast({ title: '该账号未开通企业版，请联系平台开通', icon: 'none', duration: 3000 })
              }
              session.setUser(Object.assign({}, user, {
                enterpriseId: enterpriseId || 'DEFAULT',
                enterpriseRole: role || (isAdminBypass ? 'ADMIN' : ''),
                isAdminBypass,
                passwordMustChange,
              }))
              try { wx.removeStorageSync('pendingSalesCode') } catch (_) {}

              wx.showToast({ title: '登录成功', icon: 'success' })
              setTimeout(() => {
                if (passwordMustChange) {
                  wx.reLaunch({ url: '/pages/change-password/index?force=1' })
                } else if (role === 'EMPLOYEE' && !isAdminBypass) {
                  // 员工：直接进我的任务
                  wx.reLaunch({ url: '/pages/standard-execution/tasks/index' })
                } else {
                  // ADMIN / MANAGER / REVIEWER：进企业工作台
                  wx.reLaunch({ url: '/pages/enterprise-home/index' })
                }
              }, 500)
            },
            fail: () => {
              session.logout()
              wx.showToast({ title: '企业身份校验失败，请重试', icon: 'none', duration: 3000 })
              this.setData({ entLogining: false })
            },
          })
          return
        }
        const msg = code === 404
          ? '该账号未注册，请前往网页版注册'
          : (res.data && res.data.error) || '登录失败，请检查账号和密码'
        wx.showToast({ title: msg, icon: 'none', duration: 3000 })
        this.setData({ entLogining: false })
      },
      fail: () => {
        wx.showToast({ title: '网络错误，请重试', icon: 'none' })
        this.setData({ entLogining: false })
      },
    })
  },

  goRegister() {
    // 小程序暂无注册页（register/index 是销售推广专属深色页），引导用户走网页版
    wx.showToast({ title: '请前往网页版注册：biaozhunxiaozhi.com', icon: 'none', duration: 3000 })
  },

  forgotPassword() {
    wx.showToast({ title: '请前往网页版找回密码', icon: 'none' })
  },

  // ─── 微信一键登录 ─────────────────────────────────────────

  handleWxLogin() {
    if (this.data.authing) return
    if (!this.data.agreed) {
      return wx.showToast({ title: '请先阅读并同意用户协议', icon: 'none' })
    }
    this.setData({ authing: true })
    session.ensureLogin()
      .then((user) => {
        wx.showToast({ title: '登录成功', icon: 'success' })
        setTimeout(() => {
          if (user && user.needBindPhone) {
            wx.reLaunch({ url: '/pages/bind-phone/index?source=login' })
          } else {
            wx.reLaunch({ url: '/pages/home/index' })
          }
        }, 500)
      })
      .catch((err) => {
        wx.showToast({ title: (err && err.message) || '登录失败', icon: 'none' })
        this.setData({ authing: false })
      })
  },

  goEnterpriseApply() {
    wx.navigateTo({ url: '/pages/enterprise-apply/index' })
  },

  goTerms() {
    wx.navigateTo({ url: '/pages/about/terms' })
  },

  goPrivacy() {
    wx.navigateTo({ url: '/pages/about/privacy' })
  },
})
