/**
 * 专家评审投票 — 申请表（4 步分步流程）
 *
 * 步骤：1.项目信息 / 2.专家与会议 / 3.材料上传 / 4.确认支付
 *
 * 关键改动：
 *   - 删除 targetName 输入；提交时自动 targetName = projectName
 *   - 删除"具体专业关键词"；提交时 expertKeywords = keywords
 *   - 价格走 GET /api/app/expert-votes/pricing，前端不写死
 *   - 顶部步骤条 + 底部固定操作栏
 */
const config = require('../../../utils/config')
const request = require('../../../utils/request')
const session = require('../../../utils/session')

const PROJECT_TYPES = ['标准评审', '专家投票', '项目论证', '成果评价', '技术咨询', '其他']
const STANDARD_TYPES = ['国家标准', '行业标准', '地方标准', '团体标准', '企业标准', '技术规范', '其他']
const STANDARD_STATUSES = ['立项前', '已立项', '起草中', '征求意见后', '送审稿', '报批前', '已发布', '复审中']
const INDUSTRIES = ['机械', '能源', '核工业', '化工', '电子信息', '食品', '医疗', '建材', '其他']
const EXPERT_CATEGORIES = [
  '标准化专家', '行业技术专家', '检测认证专家', '法规合规专家',
  '高校科研专家', '企业实践专家', '质量管理专家', '安全专家', '环保/绿色低碳专家',
]
const TITLE_REQS = ['不限', '高工', '正高', '教授', '研究员', '其他']
const ORG_BG_REQS = ['不限', '高校', '科研院所', '检测认证机构', '行业协会', '企业', '其他']
const CONFID_OPTIONS = [
  { value: 'NONE', label: '否' },
  { value: 'SENSITIVE', label: '一般敏感' },
  { value: 'STRICT', label: '严格保密' },
]
const SLOT_OPTIONS = [
  { value: 'MORNING', label: '上午' },
  { value: 'AFTERNOON', label: '下午' },
  { value: 'EVENING', label: '晚上' },
  { value: 'ANY', label: '全天均可' },
]
const DEFAULT_EXPERT_COUNTS = [3, 5, 7, 9]

const STEP_LABELS = ['项目信息', '专家与会议', '材料上传', '确认支付']

function pad(n) { return String(n).padStart(2, '0') }
function formatDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function minDateStr(days) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + (days || 14))
  return formatDate(d)
}

Page({
  onShareAppMessage() {
    return {
      title: '标准小智 — 标准智能平台',
      path: '/pages/expert-vote/edit/index'
    }
  },

  onShareTimeline() {
    return {
      title: '标准小智 — 标准智能平台'
    }
  },

  data: {
    // 步骤
    step: 0,
    stepLabels: STEP_LABELS,

    // 状态
    no: '',
    isEdit: false,
    saving: false,
    submitting: false,

    // 选项常量
    PROJECT_TYPES, STANDARD_TYPES, STANDARD_STATUSES, INDUSTRIES,
    EXPERT_CATEGORIES, TITLE_REQS, ORG_BG_REQS,
    CONFID_OPTIONS, SLOT_OPTIONS,
    EXPERT_COUNTS: DEFAULT_EXPERT_COUNTS,
    // 专家数量选择：末尾加"其他"
    EXPERT_COUNT_LABELS: [...DEFAULT_EXPERT_COUNTS.map((n) => `${n} 位`), '其他（自定义）'],
    expertCountPickerIdx: 1,       // 默认选 5 位（index=1）
    expertCountIsCustom: false,    // 是否自定义模式
    expertCountCustom: '',         // 自定义输入值（string）
    expertCountCustomError: '',    // 格式错误提示
    minDateStr: minDateStr(14),

    // 价格
    pricing: null,
    pricingError: false,
    estimateAmount: 0,
    minLeadDays: 14,

    // 表单 — 申请人联系信息
    contactName: '',
    contactPhone: '',

    // 表单
    projectName: '',
    projectTypeIdx: -1,
    standardTypeIdx: -1,
    standardStatusIdx: -1,
    industries: [],
    keywords: '',
    draftingOrgs: '',
    participatingOrgs: '',
    backgroundDesc: '',
    disputePoints: '',
    confidentialLevelIdx: 0,
    confidentialRemark: '',

    expertSourceType: 'PLATFORM',
    expertCategories: [],
    titleRequirements: ['不限'],
    orgBackgroundRequirements: ['不限'],
    extraExpertNote: '',
    userSpecifiedExperts: '',

    desiredDate: '',
    desiredSlotIdx: 3,
    acceptReschedule: true,
    backupTimeNote: '',

    attachments: [],
    pendingFiles: [],
    materialRemark: '',

    // 当前步骤计算属性
    isFirstStep: true,
    isLastStep: false,
  },

  onLoad(query) {
    if (!session.getToken()) {
      wx.showModal({
        title: '请先登录',
        content: '专家评审投票申请仅限已注册用户，登录后即可发起，无需开通会员。',
        confirmText: '去登录',
        cancelText: '返回',
        success(r) {
          if (r.confirm) wx.reLaunch({ url: '/pages/profile/index' })
          else wx.navigateBack({ delta: 1 })
        },
      })
      return
    }
    this._loadPricing()
    if (query && query.no) {
      this.setData({ no: String(query.no), isEdit: true })
      this.loadDraft()
    }
  },

  _loadPricing() {
    const self = this
    request({ url: '/api/app/expert-votes/pricing', method: 'GET' })
      .then((res) => {
        if (res.statusCode !== 200 || !res.data) {
          self.setData({ pricingError: true })
          return
        }
        const p = res.data
        self.setData({
          pricing: p,
          pricingError: !!p.error,
          minLeadDays: p.minLeadDays || 14,
          minDateStr: minDateStr(p.minLeadDays || 14),
          EXPERT_COUNTS: Array.isArray(p.expertCountOptions) && p.expertCountOptions.length ? p.expertCountOptions : DEFAULT_EXPERT_COUNTS,
          EXPERT_COUNT_LABELS: [...(Array.isArray(p.expertCountOptions) && p.expertCountOptions.length ? p.expertCountOptions : DEFAULT_EXPERT_COUNTS).map((n) => `${n} 位`), '其他（自定义）'],
        })
        self._refreshEstimate()
      })
      .catch(() => self.setData({ pricingError: true }))
  },

  _refreshEstimate() {
    const p = this.data.pricing
    if (!p) return this.setData({ estimateAmount: 0 })
    const count = this._getExpertCount()
    if (!count) return this.setData({ estimateAmount: 0 })
    this.setData({ estimateAmount: count * p.unitPriceYuan })
  },

  /** 读取当前有效专家数（预设或自定义），无效返回 null */
  _getExpertCount() {
    const d = this.data
    if (d.expertCountIsCustom) {
      const n = parseInt(d.expertCountCustom, 10)
      return (!isNaN(n) && n >= 3 && n % 2 === 1) ? n : null
    }
    return d.EXPERT_COUNTS[d.expertCountPickerIdx] || null
  },

  loadDraft() {
    const no = this.data.no
    if (!no) return
    request({ url: `/api/app/expert-votes/${no}`, method: 'GET' }).then((res) => {
      if (res.statusCode !== 200) {
        wx.showToast({ title: '草稿加载失败', icon: 'none' })
        return
      }
      const d = res.data || {}
      if (d.status !== 'DRAFT') {
        wx.showToast({ title: '该申请已提交，无法编辑', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 800)
        return
      }
      this.setData({
        contactName: d.contactName || '',
        contactPhone: d.contactPhone || '',
        projectName: d.projectName || '',
        projectTypeIdx: PROJECT_TYPES.indexOf(d.projectType),
        standardTypeIdx: STANDARD_TYPES.indexOf(d.standardType),
        standardStatusIdx: STANDARD_STATUSES.indexOf(d.standardStatus),
        industries: Array.isArray(d.industries) ? d.industries : [],
        keywords: d.keywords || '',
        draftingOrgs: d.draftingOrgs || '',
        participatingOrgs: d.participatingOrgs || '',
        backgroundDesc: d.backgroundDesc || '',
        disputePoints: d.disputePoints || '',
        confidentialLevelIdx: Math.max(0, CONFID_OPTIONS.findIndex((c) => c.value === d.confidentialLevel)),
        confidentialRemark: d.confidentialRemark || '',
        expertSourceType: d.expertSourceType || 'PLATFORM',
        expertCategories: Array.isArray(d.expertCategories) ? d.expertCategories : [],
        titleRequirements: Array.isArray(d.titleRequirements) && d.titleRequirements.length ? d.titleRequirements : ['不限'],
        orgBackgroundRequirements: Array.isArray(d.orgBackgroundRequirements) && d.orgBackgroundRequirements.length ? d.orgBackgroundRequirements : ['不限'],
        // 回填专家数量
        ...((() => {
          const cnt = d.expertCount || 5
          const presetIdx = this.data.EXPERT_COUNTS.indexOf(cnt)
          if (presetIdx >= 0) {
            return { expertCountPickerIdx: presetIdx, expertCountIsCustom: false, expertCountCustom: '' }
          }
          // 自定义数量：pickerIdx 指向"其他"项（最后一个）
          return {
            expertCountPickerIdx: this.data.EXPERT_COUNTS.length,
            expertCountIsCustom: true,
            expertCountCustom: String(cnt),
          }
        })()),
        extraExpertNote: d.extraExpertNote || '',
        userSpecifiedExperts: d.userSpecifiedExperts || '',
        desiredDate: d.desiredDate ? d.desiredDate.slice(0, 10) : '',
        desiredSlotIdx: Math.max(0, SLOT_OPTIONS.findIndex((s) => s.value === d.desiredSlot)),
        acceptReschedule: d.acceptReschedule !== false,
        backupTimeNote: d.backupTimeNote || '',
        materialRemark: d.materialRemark || '',
        attachments: (d.attachments || []).map((a) => ({
          id: a.id, originalName: a.originalName, size: a.size, category: a.category,
        })),
      })
      this._refreshEstimate()
    })
  },

  // 表单输入
  onInput(e) {
    const f = e.currentTarget.dataset.field
    this.setData({ [f]: e.detail.value })
  },
  pickProjectType(e) { this.setData({ projectTypeIdx: Number(e.detail.value) }) },
  pickStandardType(e) { this.setData({ standardTypeIdx: Number(e.detail.value) }) },
  pickStandardStatus(e) { this.setData({ standardStatusIdx: Number(e.detail.value) }) },
  toggleIndustry(e) {
    const v = e.currentTarget.dataset.value
    const arr = [...this.data.industries]
    const i = arr.indexOf(v)
    if (i >= 0) arr.splice(i, 1); else arr.push(v)
    this.setData({ industries: arr })
  },
  pickConfidLevel(e) { this.setData({ confidentialLevelIdx: Number(e.detail.value) }) },
  pickExpertSource(e) { this.setData({ expertSourceType: e.currentTarget.dataset.value }) },
  toggleExpertCategory(e) {
    const v = e.currentTarget.dataset.value
    const arr = [...this.data.expertCategories]
    const i = arr.indexOf(v)
    if (i >= 0) arr.splice(i, 1); else arr.push(v)
    this.setData({ expertCategories: arr })
  },
  toggleTitleReq(e) {
    const v = e.currentTarget.dataset.value
    let arr = [...this.data.titleRequirements]
    if (v === '不限') arr = ['不限']
    else {
      const i = arr.indexOf(v)
      if (i >= 0) arr.splice(i, 1); else arr.push(v)
      arr = arr.filter((x) => x !== '不限')
      if (arr.length === 0) arr = ['不限']
    }
    this.setData({ titleRequirements: arr })
  },
  toggleOrgBg(e) {
    const v = e.currentTarget.dataset.value
    let arr = [...this.data.orgBackgroundRequirements]
    if (v === '不限') arr = ['不限']
    else {
      const i = arr.indexOf(v)
      if (i >= 0) arr.splice(i, 1); else arr.push(v)
      arr = arr.filter((x) => x !== '不限')
      if (arr.length === 0) arr = ['不限']
    }
    this.setData({ orgBackgroundRequirements: arr })
  },
  pickExpertCount(e) {
    const idx = Number(e.detail.value)
    const isCustom = idx >= this.data.EXPERT_COUNTS.length // 最后一项"其他"
    this.setData({
      expertCountPickerIdx: idx,
      expertCountIsCustom: isCustom,
      expertCountCustom: isCustom ? this.data.expertCountCustom : '',
      expertCountCustomError: '',
    })
    if (!isCustom) this._refreshEstimate()
  },

  onCustomExpertCount(e) {
    const val = e.detail.value
    const n = parseInt(val, 10)
    let err = ''
    if (val && (isNaN(n) || n < 3 || n % 2 === 0)) {
      err = '请输入奇数（如 11、13、15…）'
    }
    this.setData({ expertCountCustom: val, expertCountCustomError: err })
    if (!err && val) this._refreshEstimate()
  },
  pickDesiredDate(e) { this.setData({ desiredDate: e.detail.value }) },
  pickDesiredSlot(e) { this.setData({ desiredSlotIdx: Number(e.detail.value) }) },
  toggleAcceptReschedule(e) { this.setData({ acceptReschedule: e.detail.value }) },

  // 材料
  pickFile(e) {
    const category = e.currentTarget.dataset.category || 'MAIN'
    const self = this
    const fileMaxBytes = (self.data.pricing && self.data.pricing.fileMaxMb || 50) * 1024 * 1024
    wx.chooseMessageFile({
      count: 5,
      type: 'all',
      success(r) {
        const next = [...self.data.pendingFiles]
        for (const f of r.tempFiles) {
          if (f.size > fileMaxBytes) {
            wx.showToast({ title: `${f.name} 超过单文件上限`, icon: 'none' })
            continue
          }
          next.push({ tempPath: f.path, name: f.name, size: f.size, category })
        }
        self.setData({ pendingFiles: next })
      },
    })
  },
  removePending(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const arr = [...this.data.pendingFiles]
    arr.splice(idx, 1)
    this.setData({ pendingFiles: arr })
  },
  removeAttachment(e) {
    const id = e.currentTarget.dataset.id
    if (!id || !this.data.no) return
    request({ url: `/api/app/expert-votes/${this.data.no}/attachments/${id}`, method: 'DELETE' })
      .then(() => this.setData({ attachments: this.data.attachments.filter((a) => a.id !== id) }))
  },

  // 步骤
  _setStep(s) {
    const next = Math.max(0, Math.min(3, s))
    this.setData({
      step: next,
      isFirstStep: next === 0,
      isLastStep: next === 3,
    })
    wx.pageScrollTo({ scrollTop: 0, duration: 200 })
  },
  _validateStep0() {
    const d = this.data
    if (!d.contactName.trim() || d.contactName.trim().length < 2) return '请填写申请人姓名（至少2个字符）'
    if (!/^1[3-9]\d{9}$/.test(d.contactPhone)) return '请填写有效的申请人电话'
    if (!d.projectName.trim()) return '请填写评审项目名称'
    if (d.projectTypeIdx < 0) return '请选择项目类型'
    if (d.standardTypeIdx < 0) return '请选择标准类型'
    if (d.standardStatusIdx < 0) return '请选择标准状态'
    if (d.industries.length === 0) return '请至少选择一个所属行业'
    if (!d.backgroundDesc.trim()) return '请填写项目背景说明'
    const confid = CONFID_OPTIONS[d.confidentialLevelIdx].value
    if ((confid === 'SENSITIVE' || confid === 'STRICT') && !d.confidentialRemark.trim()) {
      return '涉密项目请填写保密要求说明'
    }
    return null
  },
  _validateStep1() {
    const d = this.data
    if (d.expertCategories.length === 0) return '请至少选择一类专家类别'
    // 专家数量校验
    const cnt = this._getExpertCount()
    if (!cnt) return d.expertCountIsCustom ? '请输入有效的奇数专家数量' : '请选择专家数量'
    if (d.expertSourceType === 'USER_SPECIFIED' && !d.userSpecifiedExperts.trim()) {
      return '请填写指定专家说明'
    }
    if (!d.desiredDate) return '请选择期望会议日期'
    if (d.desiredDate < d.minDateStr) return `期望会议日期需提前 ${d.minLeadDays} 天以上`
    return null
  },
  _validateStep2() {
    const mainCount = this.data.attachments.filter((a) => a.category === 'MAIN').length
      + this.data.pendingFiles.filter((f) => f.category === 'MAIN').length
    if (mainCount === 0) return '请至少上传一份主要材料'
    return null
  },
  goNext() {
    const s = this.data.step
    let err = null
    if (s === 0) err = this._validateStep0()
    else if (s === 1) err = this._validateStep1()
    else if (s === 2) err = this._validateStep2()
    if (err) return wx.showToast({ title: err, icon: 'none' })
    this._setStep(s + 1)
  },
  goPrev() { this._setStep(this.data.step - 1) },

  // 收集 payload
  buildPayload() {
    const d = this.data
    const projectName = d.projectName.trim()
    const keywords = d.keywords.trim() || undefined
    return {
      contactName: d.contactName.trim(),
      contactPhone: d.contactPhone.trim(),
      projectName,
      targetName: projectName, // 兜底
      projectType: PROJECT_TYPES[d.projectTypeIdx],
      standardType: STANDARD_TYPES[d.standardTypeIdx],
      standardStatus: STANDARD_STATUSES[d.standardStatusIdx],
      industries: d.industries,
      keywords,
      draftingOrgs: d.draftingOrgs.trim() || undefined,
      participatingOrgs: d.participatingOrgs.trim() || undefined,
      backgroundDesc: d.backgroundDesc.trim(),
      disputePoints: d.disputePoints.trim() || undefined,
      confidentialLevel: CONFID_OPTIONS[d.confidentialLevelIdx].value,
      confidentialRemark: d.confidentialRemark.trim() || undefined,
      expertSourceType: d.expertSourceType,
      expertCategories: d.expertCategories,
      expertKeywords: keywords, // 与 keywords 用同值
      titleRequirements: d.titleRequirements,
      orgBackgroundRequirements: d.orgBackgroundRequirements,
      expertCount: this._getExpertCount(),
      extraExpertNote: d.extraExpertNote.trim() || undefined,
      userSpecifiedExperts: d.userSpecifiedExperts.trim() || undefined,
      desiredDate: d.desiredDate,
      desiredSlot: SLOT_OPTIONS[d.desiredSlotIdx].value,
      acceptReschedule: d.acceptReschedule,
      backupTimeNote: d.backupTimeNote.trim() || undefined,
      materialRemark: d.materialRemark.trim() || undefined,
    }
  },

  saveDraft() {
    if (!this.data.projectName.trim()) {
      return wx.showToast({ title: '请至少填写评审项目名称后再保存', icon: 'none' })
    }
    this.setData({ saving: true })
    this._upsertDraft()
      .then((no) => { this.setData({ no, isEdit: true }); return this._uploadPending(no) })
      .then(() => { wx.showToast({ title: '草稿已保存', icon: 'success' }); this.loadDraft() })
      .catch((e) => wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' }))
      .then(() => this.setData({ saving: false }))
  },

  _upsertDraft() {
    const payload = this.buildPayload()
    if (this.data.no) {
      return request({ url: `/api/app/expert-votes/${this.data.no}`, method: 'PATCH', data: payload })
        .then((res) => {
          if (res.statusCode !== 200) throw new Error((res.data && res.data.error) || '更新草稿失败')
          return this.data.no
        })
    }
    return request({ url: '/api/app/expert-votes', method: 'POST', data: payload }).then((res) => {
      if (res.statusCode !== 200) throw new Error((res.data && res.data.error) || '创建草稿失败')
      const no = (res.data && res.data.requestNo) || ''
      if (!no) throw new Error('返回无 requestNo')
      return no
    })
  },

  _uploadPending(no) {
    const files = this.data.pendingFiles || []
    if (files.length === 0) return Promise.resolve()
    const token = session.getToken()
    return new Promise((resolve, reject) => {
      const next = (i) => {
        if (i >= files.length) { this.setData({ pendingFiles: [] }); return resolve() }
        const f = files[i]
        wx.uploadFile({
          url: `${config.API_BASE}/api/app/expert-votes/${no}/attachments`,
          filePath: f.tempPath, name: 'file',
          formData: { category: f.category || 'MAIN' },
          header: { Authorization: `Bearer ${token}` },
          timeout: 30000,
          success: (r) => {
            if (r.statusCode === 200) return next(i + 1)
            let msg = '上传失败'
            try { msg = (JSON.parse(r.data || '{}').error) || msg } catch (e) {}
            reject(new Error(msg))
          },
          fail: () => reject(new Error('网络错误，上传失败')),
        })
      }
      next(0)
    })
  },

  submit() {
    const e0 = this._validateStep0(); if (e0) return wx.showToast({ title: e0, icon: 'none' })
    const e1 = this._validateStep1(); if (e1) return wx.showToast({ title: e1, icon: 'none' })
    const e2 = this._validateStep2(); if (e2) return wx.showToast({ title: e2, icon: 'none' })
    this.setData({ submitting: true })
    wx.showLoading({ title: '提交中...', mask: true })

    this._upsertDraft()
      .then((no) => { this.setData({ no }); return this._uploadPending(no).then(() => no) })
      .then((no) => request({ url: `/api/app/expert-votes/${no}/submit`, method: 'POST', data: {} }).then((res) => {
        if (res.statusCode !== 200) throw new Error((res.data && res.data.error) || '提交失败')
        return res.data
      }))
      .then((data) => {
        wx.hideLoading()
        this.setData({ submitting: false })
        const order = data && data.order
        const req = data && data.request
        if (!order || !order.orderNo) throw new Error('未取到订单号')
        const amountYuan = (order.amount / 100).toFixed(2)
        const title = encodeURIComponent(req.projectName || '专家评审投票')
        const requestNo = (req && req.requestNo) || this.data.no
        wx.redirectTo({
          url: `/pages/payment/index?flow=expertVote&orderNo=${order.orderNo}&amount=${amountYuan}&title=${title}&requestNo=${requestNo}`,
        })
      })
      .catch((e) => {
        wx.hideLoading()
        this.setData({ submitting: false })
        wx.showToast({ title: (e && e.message) || '提交失败', icon: 'none' })
      })
  },
})
