/**
 * 标准服务预约
 * @date   2026-03-21
 */
const config = require('../../utils/config')
const request = require('../../utils/request')
const remoteConfig = require('../../utils/remoteConfig')

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/booking/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    serviceTypes: ['团体标准', '企业标准', '不确定'],
    serviceTypeIndex: -1,
    serviceTypeLabel: '请选择',
    heroTitle: '专业标准服务',
    heroDesc: '我们提供标准编制咨询、技术审查、标准培训等专业服务，由资深专家团队为您提供定制化解决方案。',
    serviceCards: [
      { title: '团标立项', desc: '梳理立项依据、参考标准与学会资源。' },
      { title: '标准编制', desc: '提供起草、审查、论证到发布的全流程支持。' },
      { title: '技术审查', desc: '聚焦条款冲突、引用规范性和结构完整性。' }
    ],
    // 表单字段
    name: '',
    phone: '',
    organization: '',
    demandDesc: '',
    submitting: false
  },
  onLoad() {
    this._applyRemoteCopy()
  },
  _applyRemoteCopy() {
    this.setData({
      heroTitle: remoteConfig.getCopy('booking', 'hero_title', '专业标准服务'),
      heroDesc: remoteConfig.getCopy('booking', 'hero_desc', '我们提供标准编制咨询、技术审查、标准培训等专业服务，由资深专家团队为您提供定制化解决方案。'),
      serviceCards: [
        { title: remoteConfig.getCopy('booking', 'card1_title', '团标立项'), desc: remoteConfig.getCopy('booking', 'card1_desc', '梳理立项依据、参考标准与学会资源。') },
        { title: remoteConfig.getCopy('booking', 'card2_title', '标准编制'), desc: remoteConfig.getCopy('booking', 'card2_desc', '提供起草、审查、论证到发布的全流程支持。') },
        { title: remoteConfig.getCopy('booking', 'card3_title', '技术审查'), desc: remoteConfig.getCopy('booking', 'card3_desc', '聚焦条款冲突、引用规范性和结构完整性。') },
      ],
    })
  },
  chooseServiceType(e) {
    const index = Number(e.detail.value)
    this.setData({
      serviceTypeIndex: index,
      serviceTypeLabel: this.data.serviceTypes[index]
    })
  },
  onInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [field]: e.detail.value })
  },
  submit() {
    const { name, phone, organization, serviceTypeIndex, serviceTypes, demandDesc } = this.data
    if (!name.trim()) return wx.showToast({ title: '请输入姓名', icon: 'none' })
    if (!phone.trim() || phone.length !== 11) return wx.showToast({ title: '请输入11位手机号', icon: 'none' })
    if (!organization.trim()) return wx.showToast({ title: '请输入所属机构', icon: 'none' })

    this.setData({ submitting: true })

    request({
      url: '/api/app/bookings',
      method: 'POST',
      header: { 'content-type': 'application/json' },
      data: {
        name: name.trim(),
        phone: phone.trim(),
        organization: organization.trim(),
        demandType: serviceTypeIndex >= 0 ? serviceTypes[serviceTypeIndex] : undefined,
        demandDesc: demandDesc.trim() || undefined,
        source: 'miniapp'
      },
      success: (res) => {
        if (res.statusCode === 200) {
          wx.showToast({ title: '预约已提交', icon: 'success' })
          // 清空表单
          this.setData({
            name: '', phone: '', organization: '', demandDesc: '',
            serviceTypeIndex: -1, serviceTypeLabel: '请选择'
          })
        } else {
          wx.showToast({ title: (res.data && res.data.error) || '提交失败', icon: 'none' })
        }
      },
      fail: () => {
        wx.showToast({ title: '网络错误，请重试', icon: 'none' })
      },
      complete: () => {
        this.setData({ submitting: false })
      }
    })
  }
})
