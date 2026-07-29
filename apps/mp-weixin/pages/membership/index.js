/**
 * 会员开通页 — 真实 API 对接
 * @date   2026-03-24
 */
var config = require('../../utils/config')
var session = require('../../utils/session')
var request = require('../../utils/request')
var tracker = require('../../utils/tracker')
var remoteConfig = require('../../utils/remoteConfig')
var DEFAULT_INFO_NOTICE = '本平台展示的标准信息及 AI 辅助分析内容仅供参考，不代表官方发布内容或正式审查结论；标准的引用、使用及传播，请以官方或授权渠道为准，并遵守相关版权规定。'

function normalizePlanDisplay(plan) {
  if (!plan || !plan.id) return plan
  if (plan.id === 'personal') {
    plan.features = [
      '知识库检索与详情页不限次',
      '呼叫小智 / AI 编写辅助不限次',
      '一对一比对不限次',
      '全库相似度分析 10 次/年完整报告',
    ]
    plan.note = '一对一比对为会员专属功能。'
    return plan
  }
  if (plan.id === 'pro') {
    plan.features = [
      '包含个人会员全部权益',
      '呼叫小智 / AI 编写辅助不限次',
      '一对一比对不限次',
      '全库相似度分析不限次完整报告',
    ]
    plan.note = '适合高频标准查询、AI 编写辅助和相似度分析场景。'
    return plan
  }
  return plan
}

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/membership/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    loading: true,
    plans: [],
    selectedId: 'pro',
    currentTier: 'free',
    isPro: false,
    // 文案 — wxml 为事实源；远程配置失败 fallback 与字面值完全一致
    copy: {
      alreadyProTitle: '您已是专业会员',
      alreadyProDesc: '当前为最高等级，感谢您的支持',
      upgradeHint: '您当前为个人会员，可升级到专业版（仅需补差价）',
      promoBanner: '早鸟优惠进行中',
      promoTag: '限时优惠',
      priceContact: '联系销售',
    },
    infoNotice: DEFAULT_INFO_NOTICE,
    btnText: '立即开通',
  },

  onShow() {
    tracker.trackPageView('pages/membership/index')
    this._applyRemoteCopy()
    // 未绑定手机号 → 拦截
    var user = session.getUser()
    if (user && !user.phone) {
      wx.showModal({
        title: '请先绑定手机号',
        content: '绑定手机号后才能开通会员',
        confirmText: '去绑定',
        success: function (res) {
          if (res.confirm) {
            wx.navigateTo({ url: '/pages/bind-phone/index' })
          } else {
            wx.navigateBack()
          }
        }
      })
      return
    }
    this.loadPlans()
  },

  _applyRemoteCopy() {
    remoteConfig.loadRemoteConfig().then(() => {
      this.setData({
        copy: {
          alreadyProTitle: remoteConfig.getCopy('membership', 'mp_copy_membership_already_pro_title', '您已是专业会员'),
          alreadyProDesc: remoteConfig.getCopy('membership', 'mp_copy_membership_already_pro_desc', '当前为最高等级，感谢您的支持'),
          upgradeHint: remoteConfig.getCopy('membership', 'mp_copy_membership_upgrade_hint', '您当前为个人会员，可升级到专业版（仅需补差价）'),
          promoBanner: remoteConfig.getCopy('membership', 'mp_copy_membership_promo_banner', '早鸟优惠进行中'),
          promoTag: remoteConfig.getCopy('membership', 'mp_copy_membership_promo_tag', '限时优惠'),
          priceContact: remoteConfig.getCopy('membership', 'mp_copy_membership_price_contact', '联系销售'),
        },
        infoNotice: remoteConfig.getMembershipInfoNotice(DEFAULT_INFO_NOTICE),
      })
    }).catch(() => {
      this.setData({
        infoNotice: DEFAULT_INFO_NOTICE,
      })
    })
  },

  loadPlans() {
    this.setData({ loading: true })
    request({
      url: '/api/app/membership/plans',
      method: 'GET',
      success: (res) => {
        var data = res.data
        var allPlans = ((data && data.plans) ? data.plans : []).map(function (plan) {
          return normalizePlanDisplay(Object.assign({}, plan))
        })
        var current = data && data.currentMembership
        var tier = 'free'

        if (current && current.status === 'ACTIVE' && current.plan) {
          tier = current.plan.id || 'free'
        }

        // 已是更高等级会员 → 不需要再开通
        if (tier === 'pro' || tier === 'enterprise') {
          this.setData({ plans: [], currentTier: tier, isPro: true, loading: false })
          return
        }

        var plans = allPlans
        // 已是个人会员 → 只展示专业版（升级），不展示个人版（降级无意义）
        if (tier === 'personal') {
          plans = allPlans.filter(function (p) { return p.id === 'pro' || p.id === 'enterprise' })
        }

        this.setData({ plans: plans, selectedId: 'pro', currentTier: tier, isPro: false, loading: false })
        this._refreshBtnText()
      },
      fail: () => {
        wx.showToast({ title: '加载会员方案失败', icon: 'none' })
        this.setData({ loading: false })
      }
    })
  },

  getSelectedPlan() {
    return this.data.plans.find(function (item) { return item.id === this.data.selectedId }.bind(this)) || this.data.plans[0]
  },

  choosePlan(e) {
    this.setData({ selectedId: e.currentTarget.dataset.id })
    this._refreshBtnText()
  },

  /** 按钮文案随选中套餐 / 当前等级变化；远程配置失败 fallback 即字面值 */
  _refreshBtnText() {
    var sel = this.data.selectedId
    var tier = this.data.currentTier
    var text
    if (sel === 'enterprise') {
      text = remoteConfig.getCopy('membership', 'mp_copy_membership_btn_enterprise', '联系销售')
    } else if (tier === 'personal') {
      text = remoteConfig.getCopy('membership', 'mp_copy_membership_btn_upgrade', '立即升级')
    } else {
      text = remoteConfig.getCopy('membership', 'mp_copy_membership_btn_subscribe', '立即开通')
    }
    this.setData({ btnText: text })
  },

  submit() {
    var plan = this.getSelectedPlan()
    if (!plan) return
    if (!plan.price) {
      wx.showToast({ title: '企业版请联系销售开通', icon: 'none' })
      return
    }
    var self = this

    // 实时拉 profile 校验当前会员状态（绕开本地 currentTier 缓存，防跨端不同步）
    request({
      url: '/api/app/profile',
      method: 'GET',
      success: function (res) {
        var profile = (res && res.data) || {}
        var cm = profile.membership
        var currentPlan = (cm && cm.status === 'ACTIVE' && cm.plan && cm.plan.id) ? cm.plan.id : null

        if (currentPlan) {
          var tr = { personal: 1, pro: 2, enterprise: 3 }
          var planLabel = plan.id === 'pro' ? '专业' : (plan.id === 'personal' ? '个人' : '企业')
          var currentLabel = currentPlan === 'pro' ? '专业' : (currentPlan === 'personal' ? '个人' : '企业')
          if ((tr[plan.id] || 0) <= (tr[currentPlan] || 0)) {
            wx.showToast({ title: '您已是' + currentLabel + '会员，无需购买' + planLabel + '会员', icon: 'none', duration: 2500 })
            // 同步刷新本页 tier，避免按钮重复显示
            self.loadPlans()
            return
          }
        }
        self._goPayment(plan, currentPlan)
      },
      fail: function () {
        // 预检失败放行，不阻塞用户
        self._goPayment(plan, self.data.currentTier)
      }
    })
  },

  _goPayment(plan, currentPlan) {
    // 个人会员购买专业版 → 走升级流程（补差价）
    if (currentPlan === 'personal' && plan.id === 'pro') {
      var personalPlan = this.data.plans.find(function (p) { return p.id === 'personal' })
      // 接口失败 / 数据缺失 → 不假设价格（删除 1998 兜底，防假价下单）
      if (!personalPlan || !personalPlan.price) {
        wx.showToast({ title: '升级差价加载失败，请稍后再试', icon: 'none', duration: 2500 })
        return
      }
      var personalPrice = personalPlan.price
      var diff = plan.price - personalPrice
      wx.navigateTo({ url: '/pages/payment/index?flow=upgrade&from=personal&to=pro&amount=' + diff })
      return
    }

    wx.navigateTo({ url: '/pages/payment/index?flow=membership&planId=' + plan.id + '&amount=' + plan.price + '&title=' + encodeURIComponent(plan.name) })
  },

  goBenefits() {
    wx.navigateTo({ url: '/pages/membership-benefits/index' })
  }
})
