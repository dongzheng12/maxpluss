/**
 * 我的会员 — 会员详情 + 升级/开通（从 API 读取方案数据）
 * @date   2026-03-31
 */
const session = require('../../utils/session')
const request = require('../../utils/request')
const remoteConfig = require('../../utils/remoteConfig')

const DEFAULT_FREE_BENEFITS = [
  '标准信息查询：每天 5 次',
  '知识图谱：每天 5 次',
  '技术委员会查询：不限次',
  '呼叫小智 / AI 编写辅助：每天 5 次',
  '全库相似度分析：会员可用（免费用户不可用）',
]
const DEFAULT_INFO_NOTICE = '本平台展示的标准信息及 AI 辅助分析内容仅供参考，不代表官方发布内容或正式审查结论；标准的引用、使用及传播，请以官方或授权渠道为准，并遵守相关版权规定。'

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/my-member/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    tier: 'free',
    tierLabel: '',
    isFree: true,
    isPersonal: false,
    isPro: false,
    expireDate: '',
    features: [],
    upgradeCost: 0,
    freeBenefits: DEFAULT_FREE_BENEFITS,
    infoNotice: DEFAULT_INFO_NOTICE,
  },

  onShow() {
    this.applyRemoteCopy()
    const user = session.getUser()
    // 未绑定手机号 → 拦截，跳绑定页
    if (user && !user.phone) {
      wx.showModal({
        title: '请先绑定手机号',
        content: '绑定手机号后才能查看会员信息和开通会员',
        confirmText: '去绑定',
        success: (res) => {
          if (res.confirm) {
            wx.navigateTo({ url: '/pages/bind-phone/index' })
          } else {
            wx.navigateBack()
          }
        }
      })
      return
    }
    this.loadFromApi()
  },

  applyRemoteCopy() {
    remoteConfig.loadRemoteConfig().then(() => {
      this.setData({
        freeBenefits: remoteConfig.getMemberFreeBenefits(DEFAULT_FREE_BENEFITS),
        infoNotice: remoteConfig.getMembershipInfoNotice(DEFAULT_INFO_NOTICE),
      })
    }).catch(() => {
      this.setData({
        freeBenefits: DEFAULT_FREE_BENEFITS,
        infoNotice: DEFAULT_INFO_NOTICE,
      })
    })
  },

  loadFromApi() {
    const user = session.getUser()
    request({
      url: '/api/app/membership/plans',
      method: 'GET',
      success: (res) => {
        const data = res.data || {}
        const allPlans = data.plans || []
        const current = data.currentMembership

        // 真实会员等级：优先用 API 返回，fallback 到本地
        let tier = 'free'
        if (current && current.status === 'ACTIVE' && current.plan) {
          tier = current.plan.id || 'free'
        } else {
          tier = session.getMemberTier()
        }

        // 从 API 方案中取 label 和 features
        const planMap = {}
        allPlans.forEach(function (p) { planMap[p.id] = p })
        const currentPlan = planMap[tier]
        const tierLabel = currentPlan ? currentPlan.name : '免费用户'
        const features = currentPlan ? currentPlan.features : []

        // 过期日期
        let expireDate = ''
        if (current && current.endAt) {
          const dt = new Date(current.endAt)
          expireDate = dt.getFullYear() + '/' + (dt.getMonth() + 1) + '/' + dt.getDate()
        } else if (user && user.memberExpire) {
          const dt = new Date(user.memberExpire)
          expireDate = dt.getFullYear() + '/' + (dt.getMonth() + 1) + '/' + dt.getDate()
        }

        // 升级差价
        let upgradeCost = 0
        if (tier === 'personal' && planMap.pro && planMap.personal) {
          upgradeCost = planMap.pro.price - planMap.personal.price
        }

        this.setData({
          tier,
          tierLabel,
          isFree: tier === 'free',
          isPersonal: tier === 'personal',
          isPro: tier === 'pro' || tier === 'enterprise',
          expireDate,
          features,
          upgradeCost
        })
      },
      fail: () => {
        // API 失败时 fallback 到本地状态
        const tier = session.getMemberTier()
        this.setData({
          tier,
          tierLabel: tier === 'pro' ? '专业会员' : tier === 'personal' ? '个人会员' : '免费用户',
          isFree: tier === 'free',
          isPersonal: tier === 'personal',
          isPro: tier === 'pro' || tier === 'enterprise',
          expireDate: '',
          features: [],
          upgradeCost: 0
        })
      }
    })
  },

  goMembership() {
    wx.navigateTo({ url: '/pages/membership/index' })
  },

  doUpgrade() {
    wx.showModal({
      title: '升级到专业会员',
      content: '仅需补差价 ￥' + this.data.upgradeCost + ' 即可升级为专业会员，享受全库相似度分析不限次、团标摘要查阅等权益。',
      confirmText: '立即升级',
      success: (res) => {
        if (res.confirm) {
          wx.navigateTo({
            url: '/pages/payment/index?flow=upgrade&from=personal&to=pro&amount=' + this.data.upgradeCost
          })
        }
      }
    })
  }
})
