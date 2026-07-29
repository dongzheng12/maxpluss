/**
 * 修改密码 — 旧密码 + 新密码（≥6位）
 * 注：直接用 wx.request，绕过 utils/request 拦截器。
 * 因为旧密码错后端返回 401，拦截器会把 401 当登录过期 reLaunch 到 profile，这里要自己处理。
 */
const session = require('../../utils/session')
const config = require('../../utils/config')

Page({
  data: {
    oldPassword: '',
    newPassword: '',
    submitting: false,
    force: false,
  },

  onLoad(options) {
    this.setData({ force: options && options.force === '1' })
  },

  onOldInput(e) {
    this.setData({ oldPassword: e.detail.value })
  },

  onNewInput(e) {
    this.setData({ newPassword: e.detail.value })
  },

  submit() {
    if (this.data.submitting) return
    const { oldPassword, newPassword } = this.data
    if (!oldPassword) {
      return wx.showToast({ title: '请输入旧密码', icon: 'none' })
    }
    if (!newPassword || newPassword.length < 6) {
      return wx.showToast({ title: '新密码至少 6 位', icon: 'none' })
    }

    this.setData({ submitting: true })
    wx.request({
      url: `${config.API_BASE}/api/app/auth/change-password`,
      method: 'POST',
      header: { Authorization: 'Bearer ' + session.getToken() },
      data: { oldPassword, newPassword },
      timeout: 15000,
      success: (res) => {
        if (res.statusCode === 200) {
          const user = session.getUser()
          if (user) {
            user.passwordMustChange = false
            session.setUser(user)
          }
          wx.showToast({ title: '密码修改成功', icon: 'success' })
          setTimeout(() => {
            if (this.data.force && user && user.enterpriseId) {
              if (user.enterpriseRole === 'EMPLOYEE' && !user.isAdminBypass) {
                wx.reLaunch({ url: '/pages/standard-execution/tasks/index' })
              } else {
                wx.reLaunch({ url: '/pages/enterprise-home/index' })
              }
              return
            }
            wx.navigateBack()
          }, 800)
          return
        }
        // 401=原密码错 / 400=参数错：自己 toast，不让拦截器 reLaunch
        const msg = (res.data && res.data.error) || '修改失败，请重试'
        wx.showToast({ title: msg, icon: 'none', duration: 3000 })
        this.setData({ submitting: false })
      },
      fail: () => {
        wx.showToast({ title: '网络错误，请重试', icon: 'none' })
        this.setData({ submitting: false })
      },
    })
  },
})
