/**
 * 销售专属注册欢迎页（小程序 webview 场景）
 * - onLoad 接收 ?salesCode=xxx，存 storage 供后续 wx-login 归因使用
 * - 拉公开接口展示销售姓名
 * - 点「微信快速登录」→ ensureLogin（内部调 wx-login 并带 salesCode）→ 跳首页
 */
const session = require('../../utils/session')
const config = require('../../utils/config')
const remoteConfig = require('../../utils/remoteConfig')

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/register/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    activeTab: 'personal',
    salesCode: '',
    salesName: '',
    loading: true,
    authing: false,
    agreed: false,
    // 注册页价值点 — wxml 为事实源，远程配置失败 fallback 与字面值完全一致
    benefits: [
      'AI 标准问答，秒出结果',
      'AI 文档比对，自动出报告',
      '扫一扫识标准，AI 秒出结果',
    ],
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab && tab !== this.data.activeTab) this.setData({ activeTab: tab })
  },

  toggleAgreed() {
    this.setData({ agreed: !this.data.agreed })
  },

  onLoad(options) {
    // 接入远程配置（失败时 data.benefits 保持上面字面 fallback，与提审 wxml 一致）
    this.setData({
      benefits: [
        remoteConfig.getCopy('register', 'mp_copy_register_value_1', 'AI 标准问答，秒出结果'),
        remoteConfig.getCopy('register', 'mp_copy_register_value_2', 'AI 文档比对，自动出报告'),
        remoteConfig.getCopy('register', 'mp_copy_register_value_3', '扫一扫识标准，AI 秒出结果'),
      ],
    })

    const salesCode = (options && options.salesCode) ? String(options.salesCode).trim() : ''
    if (salesCode) {
      try { wx.setStorageSync('pendingSalesCode', salesCode) } catch (_) {}
    }
    this.setData({ salesCode })

    if (!salesCode) {
      this.setData({ loading: false })
      return
    }

    // 拉销售姓名（公开接口，无需登录）
    wx.request({
      url: `${config.API_BASE}/api/public/sales/${encodeURIComponent(salesCode)}`,
      method: 'GET',
      timeout: 10000,
      success: (res) => {
        if (res.statusCode === 200 && res.data && res.data.realName) {
          this.setData({ salesName: res.data.realName, loading: false })
        } else {
          this.setData({ loading: false })
        }
      },
      fail: () => this.setData({ loading: false }),
    })
  },

  handleAuth() {
    if (this.data.authing) return
    if (!this.data.agreed) {
      return wx.showToast({ title: '请先阅读并同意用户协议', icon: 'none' })
    }
    this.setData({ authing: true })
    session.ensureLogin()
      .then((user) => {
        wx.showToast({ title: '欢迎体验', icon: 'success' })
        setTimeout(() => {
          // phone=null 用户引导绑定（销售归因后续可达短信/Web 跨端登录）
          // bind-phone 通过 source=register 标记，绑定/跳过都 reLaunch 到 home，不返回 register
          if (user && user.needBindPhone) {
            wx.reLaunch({ url: '/pages/bind-phone/index?source=register' })
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

  goEnterpriseLogin() {
    wx.navigateTo({ url: '/pages/login/index?tab=enterprise' })
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
