/**
 * 企业版申请表单 — 公开接口，无需登录
 * POST /api/app/enterprise/apply
 * 失败 429：限流提示；其它非 2xx：服务端 error 透传
 */
const request = require('../../utils/request')

Page({
  data: {
    name: '',
    position: '',
    company: '',
    phone: '',
    requirement: '',
    loading: false,
    submitted: false,
  },

  onShareAppMessage() {
    return { title: '标准小智 — 企业定制版', path: '/pages/login/index' }
  },

  onShareTimeline() {
    return { title: '标准小智 — 企业定制版' }
  },

  onNameInput(e)        { this.setData({ name:        e.detail.value }) },
  onPositionInput(e)    { this.setData({ position:    e.detail.value }) },
  onCompanyInput(e)     { this.setData({ company:     e.detail.value }) },
  onPhoneInput(e)       { this.setData({ phone:       e.detail.value.trim() }) },
  onRequirementInput(e) { this.setData({ requirement: e.detail.value }) },

  onSubmit() {
    if (this.data.loading) return
    const { name, position, company, phone, requirement } = this.data
    if (!name.trim())     return wx.showToast({ title: '请输入姓名',     icon: 'none' })
    if (!position.trim()) return wx.showToast({ title: '请输入职位',     icon: 'none' })
    if (!company.trim())  return wx.showToast({ title: '请输入公司名称', icon: 'none' })
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      return wx.showToast({ title: '请输入有效手机号', icon: 'none' })
    }

    this.setData({ loading: true })
    request({
      url: '/api/app/enterprise/apply',
      method: 'POST',
      data: {
        name:        name.trim(),
        position:    position.trim(),
        company:     company.trim(),
        phone,
        requirement: (requirement || '').trim(),
      },
    })
      .then((res) => {
        if (res.statusCode === 200 && res.data && res.data.success) {
          this.setData({ submitted: true, loading: false })
        } else if (res.statusCode === 429) {
          wx.showToast({ title: '请求过于频繁，请稍后再试', icon: 'none' })
          this.setData({ loading: false })
        } else {
          const msg = (res.data && res.data.error) || '提交失败'
          wx.showToast({ title: msg, icon: 'none' })
          this.setData({ loading: false })
        }
      })
      .catch(() => {
        wx.showToast({ title: '网络错误，请稍后重试', icon: 'none' })
        this.setData({ loading: false })
      })
  },

  goHome() {
    wx.reLaunch({ url: '/pages/home/index' })
  },
})
