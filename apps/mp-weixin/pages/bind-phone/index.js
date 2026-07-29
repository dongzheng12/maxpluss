const session = require('../../utils/session')
const request = require('../../utils/request')

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/bind-phone/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    phone: '',
    smsCode: '',
    loading: false,
    sendingCode: false,
    smsCountdown: 0,
    source: '', // 'register' = 来自注册页引导，跳过/完成后 reLaunch home；其他则 navigateBack
  },

  onLoad(options) {
    if (options && options.source) {
      this.setData({ source: String(options.source) })
    }
  },

  onPhoneInput(e) {
    this.setData({ phone: e.detail.value.trim() })
  },

  onSmsCodeInput(e) {
    this.setData({ smsCode: e.detail.value.trim() })
  },

  async onSendCode() {
    const phone = this.data.phone
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      wx.showToast({ title: '请输入有效手机号', icon: 'none' })
      return
    }

    this.setData({ sendingCode: true })
    try {
      const res = await request({
        url: '/api/app/auth/send-code',
        method: 'POST',
        data: {
          target: phone,
          type: 'phone',
          purpose: 'bind',
        }
      })

      if (res.statusCode === 200) {
        wx.showToast({ title: '验证码已发送', icon: 'success' })
        this.startCountdown()
      } else {
        wx.showToast({ title: res.data?.error || '发送失败', icon: 'none' })
      }
    } catch (e) {
      wx.showToast({ title: '发送失败，请重试', icon: 'none' })
    } finally {
      this.setData({ sendingCode: false })
    }
  },

  startCountdown() {
    this.setData({ smsCountdown: 60 })
    this._timer = setInterval(() => {
      if (this.data.smsCountdown <= 1) {
        clearInterval(this._timer)
        this.setData({ smsCountdown: 0 })
      } else {
        this.setData({ smsCountdown: this.data.smsCountdown - 1 })
      }
    }, 1000)
  },

  onUnload() {
    if (this._timer) clearInterval(this._timer)
  },

  async onSubmit() {
    const { phone, smsCode } = this.data
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      wx.showToast({ title: '请输入有效手机号', icon: 'none' })
      return
    }
    if (!/^\d{6}$/.test(smsCode)) {
      wx.showToast({ title: '请输入6位验证码', icon: 'none' })
      return
    }

    this.setData({ loading: true })
    try {
      const res = await request({
        url: '/api/app/auth/bind-phone',
        method: 'POST',
        data: { phone, smsCode }
      })

      if (res.statusCode === 200 && res.data && res.data.user) {
        const user = res.data.user
        if (res.data.membership && res.data.membership.plan) {
          user.memberTier = res.data.membership.plan.id || 'free'
          user.memberExpire = res.data.membership.endAt
        } else {
          // 没有 membership 返回时，保留原有等级（不覆盖为 undefined）
          const oldUser = session.getUser()
          if (oldUser && oldUser.memberTier) {
            user.memberTier = oldUser.memberTier
            user.memberExpire = oldUser.memberExpire
          }
        }
        // 先更新 token（合并后身份可能变了），再更新 user
        if (res.data.token) session.setToken(res.data.token)
        session.setUser(user)
        // 清除旧的每日用量计数（身份已变，计数应重置）
        try { wx.removeStorageSync('standard_xz_daily_usage') } catch (e) {}

        const msg = res.data.merged ? '账号已合并，数据已同步' : '手机号绑定成功'
        wx.showToast({ title: msg, icon: 'success' })
        setTimeout(() => {
          if (this.data.source === 'register') {
            wx.reLaunch({ url: '/pages/home/index' })
          } else {
            wx.navigateBack()
          }
        }, 1500)
      } else {
        wx.showToast({ title: res.data?.error || '绑定失败', icon: 'none' })
      }
    } catch (e) {
      // 401 已在 request.js 处理
    } finally {
      this.setData({ loading: false })
    }
  },

  onSkip() {
    if (this.data.source === 'register') {
      wx.reLaunch({ url: '/pages/home/index' })
    } else {
      wx.navigateBack()
    }
  }
})
