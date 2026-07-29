/**
 * 我的 — 个人中心
 * @date   2026-03-21
 */
const session = require('../../utils/session')
const request = require('../../utils/request')
const remoteConfig = require('../../utils/remoteConfig')

const TIER_LABELS = { free: '免费用户', personal: '个人会员', pro: '专业会员', enterprise: '企业版会员' }
const DEFAULT_PROFILE_LOGIN_HINT = '登录后享受更多权益'
const DEFAULT_PROFILE_MEMBERSHIP_HINT = '享受公开范围标准在线查看与快捷获取'

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/profile/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    user: null,
    hasAvatar: false,
    displayName: '点击登录',
    displaySubtitle: DEFAULT_PROFILE_LOGIN_HINT,
    isPaid: false,
    tierLabel: '',
    expireDate: '',
    needBindPhone: false,
    profileMembershipHint: DEFAULT_PROFILE_MEMBERSHIP_HINT,
  },

  onShow() {
    this._applyRemoteCopy()
    this.syncUser()
    // 每次进入页面从后端刷新用户信息，保证 phone/会员状态是最新的
    this._refreshProfile()
  },

  _applyRemoteCopy() {
    remoteConfig.loadRemoteConfig().then(() => {
      this.setData({
        profileMembershipHint: remoteConfig.getProfileMembershipHint(DEFAULT_PROFILE_MEMBERSHIP_HINT),
      })
      this.syncUser()
    }).catch(() => {
      this.setData({ profileMembershipHint: DEFAULT_PROFILE_MEMBERSHIP_HINT })
      this.syncUser()
    })
  },

  _refreshProfile() {
    if (!session.isLoggedIn()) return
    request({ url: '/api/app/profile' }).then(res => {
      if (res.statusCode === 200 && res.data && res.data.user) {
        const cached = session.getUser() || {}
        const fresh = res.data.user
        // 合并会员信息
        if (res.data.membership && res.data.membership.plan) {
          fresh.memberTier = res.data.membership.plan.id || 'free'
          fresh.memberExpire = res.data.membership.endAt
        } else {
          fresh.memberTier = cached.memberTier || 'free'
          fresh.memberExpire = cached.memberExpire
        }
        // 保留微信头像等本地字段
        if (!fresh.avatarUrl && cached.avatarUrl) fresh.avatarUrl = cached.avatarUrl
        if (!fresh.nickName && cached.nickName) fresh.nickName = cached.nickName
        session.setUser(fresh)
        this.syncUser()
      }
    }).catch(() => {})
  },

  syncUser() {
    const user = session.getUser()
    const tier = session.getMemberTier()
    const paid = session.isPaid()

    let expireDate = ''
    if (user && user.memberExpire) {
      const dt = new Date(user.memberExpire)
      expireDate = `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}`
    } else if (tier !== 'free' && user && user.createdAt) {
      const d = new Date(user.createdAt)
      d.setFullYear(d.getFullYear() + 1)
      expireDate = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
    }

    this.setData({
      user,
      hasAvatar: !!(user && user.avatarUrl),
      displayName: user && (user.name || user.nickName) ? (user.name || user.nickName) : '点击登录',
      displaySubtitle: user
        ? (user.phone ? `已绑定 ${user.phone.slice(0,3)}****${user.phone.slice(-4)}` : '微信账号已连接')
        : remoteConfig.getProfileLoginHint(DEFAULT_PROFILE_LOGIN_HINT),
      isPaid: paid,
      tierLabel: TIER_LABELS[tier] || '免费用户',
      expireDate,
      needBindPhone: session.needBindPhone()
    })
  },

  onHeroTap() {
    if (!this.data.user) this.handleLogin()
  },

  handleLogin() {
    session
      .ensureLogin((user) => {
        getApp().globalData.user = user
        this.syncUser()
        wx.showToast({ title: '登录成功', icon: 'success' })
        // 首次登录引导绑定手机
        if (user.needBindPhone) {
          setTimeout(() => {
            wx.showModal({
              title: '绑定手机号',
              content: '绑定手机号后可在电脑端登录，数据互通',
              confirmText: '去绑定',
              cancelText: '稍后再说',
              success: (res) => {
                if (res.confirm) {
                  wx.navigateTo({ url: '/pages/bind-phone/index' })
                }
              }
            })
          }, 1500)
        }
      })
      .catch(() => {
        wx.showToast({ title: '登录失败，请重试', icon: 'none' })
      })
  },

  goMembership() {
    wx.navigateTo({ url: '/pages/membership/index' })
  },
  goMyMember() {
    wx.navigateTo({ url: '/pages/my-member/index' })
  },
  goMyCoupons() {
    session.ensureLogin(() => wx.navigateTo({ url: '/pages/my-coupons/index' }))
  },
  goOrders() {
    session.ensureLogin(() => wx.navigateTo({ url: '/pages/orders/index' }))
  },
  goBookings() {
    session.ensureLogin(() => wx.navigateTo({ url: '/pages/booking-records/index' }))
  },
  goReferral() {
    session.ensureLogin(() => wx.navigateTo({ url: '/pages/referral/index' }))
  },
  goNotificationSettings() {
    session.ensureLogin(() => wx.navigateTo({ url: '/pages/notification-settings/index' }))
  },
  goFavorites() {
    session.ensureLogin(() => wx.navigateTo({ url: '/pages/favorites/index' }))
  },
  goCompare() {
    session.ensureLogin(() => wx.switchTab({ url: '/pages/compare/index' }))
  },
  goAbout() {
    wx.navigateTo({ url: '/pages/about/index' })
  },
  goBindPhone() {
    wx.navigateTo({ url: '/pages/bind-phone/index' })
  },
  goSettings() {
    session.ensureLogin(() => wx.navigateTo({ url: '/pages/settings/index' }))
  },
  goService: function () {
    var email = remoteConfig.getContact('contact_email', 'biaozhunxiaozhi@tbzy.org.cn')
    wx.showModal({
      title: '联系客服',
      content: '如有订单、发票、会员服务或使用问题，请通过邮箱联系我们\n\n' + email,
      confirmText: '复制邮箱',
      cancelText: '关闭',
      success: function (res) {
        if (res.confirm) {
          wx.setClipboardData({
            data: email,
            success: function () {
              wx.showToast({ title: '已复制邮箱地址', icon: 'success' })
            }
          })
        }
      },
      fail: function (err) {
        console.error('[profile] showModal fail', err)
      }
    })
  }
})
