/**
 * 任务详情 — onLoad 非阻塞触发 view（PENDING→IN_PROGRESS）
 * 时间线竖排折叠展示历史提交；底部按钮根据 assignee.status 切换
 */
const se = require('../../../utils/standardExecution')

const LOAD_FAILURE_COOLDOWN_MS = 4000

const REQUIREMENT_SUBMIT_LABEL = {
  TEXT: '文本填写',
  IMAGE: '图片上传',
  FILE: '文件上传',
  STRUCTURED: '结构化填写',
  QUIZ: '题库答题',
  LEARNING: '学习确认',
}

const DEFAULT_REQUIREMENT_SUBMIT_OPTIONS = ['TEXT', 'IMAGE']

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function compactText(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function normalizeRequirementSubmitOptions(raw) {
  const values = Array.isArray(raw) && raw.length ? raw : DEFAULT_REQUIREMENT_SUBMIT_OPTIONS
  const seen = {}
  return values.filter((option) => {
    if (!REQUIREMENT_SUBMIT_LABEL[option] || seen[option]) return false
    seen[option] = true
    return true
  })
}

function submitTags(options) {
  return options.map((option) => ({
    mode: option,
    label: REQUIREMENT_SUBMIT_LABEL[option] || option,
  }))
}

function optionHint(config, options) {
  const parts = []
  if (options.indexOf('TEXT') >= 0) parts.push(compactText(config.textPrompt, '填写执行说明'))
  if (options.indexOf('IMAGE') >= 0 || options.indexOf('FILE') >= 0) {
    const required = config.attachmentRequired === false ? 0 : Math.max(1, Number(config.attachmentMinCount || 1))
    const max = Number(config.attachmentMaxCount || 20)
    parts.push(`${required > 0 ? `附件至少 ${required} 个` : '附件可选'}，最多 ${max} 个`)
  }
  if (options.indexOf('STRUCTURED') >= 0) parts.push(`结构化填写 ${asArray(config.structuredFields).length || 1} 项`)
  if (options.indexOf('QUIZ') >= 0) parts.push(`题库答题${config.quizQuestionCount ? ` ${config.quizQuestionCount} 题` : ''}`)
  if (options.indexOf('LEARNING') >= 0) parts.push(`确认学习材料 ${asArray(config.learningMaterials).length || 0} 份`)
  return parts.join('；') || '按本要求项配置提交。'
}

Page({
  _loadPromise: null,
  _suppressNextShowLoad: false,
  _lastFailureAt: 0,

  data: {
    taskId: '',
    loading: true,
    detail: null,
    fieldRows: [],
    submitModeTags: [],
    requirementRows: [],
    lifecycleRows: [],
    // 折叠状态：submissionId → bool
    expanded: {},
    reqExpanded: false,  // 关联检查点原文折叠
    error: '',
  },

  toggleReq() {
    this.setData({ reqExpanded: !this.data.reqExpanded })
  },

  onLoad(opts) {
    const id = opts && opts.id
    if (!id) {
      this.setData({ loading: false, error: '缺少任务 ID' })
      return
    }
    this.setData({ taskId: id })
    // 非阻塞触发 view
    se.viewTask(id)
    this._suppressNextShowLoad = true
    this._load({ force: true })
  },

  onShow() {
    if (this._suppressNextShowLoad) {
      this._suppressNextShowLoad = false
      return
    }
    if (this.data.taskId && !this.data.loading) {
      // 从提交页返回时刷新
      this._load()
    }
  },

  _load(options) {
    const opts = options || {}
    if (this._loadPromise) return this._loadPromise
    const now = Date.now()
    if (!opts.force && this._lastFailureAt && now - this._lastFailureAt < LOAD_FAILURE_COOLDOWN_MS) {
      return Promise.resolve(null)
    }

    this.setData({ loading: true })
    this._loadPromise = se.getTaskDetail(this.data.taskId)
      .then((d) => this.setData({
        detail: d,
        fieldRows: se.submitForms.buildFieldRows(d),
        submitModeTags: se.submitForms.modeTags(d && d.task && d.task.submitFormConfig),
        requirementRows: this._buildRequirementRows(d),
        lifecycleRows: se.submitForms.lifecycleRows(d),
        loading: false,
        error: '',
      }))
      .catch((e) => {
        this._lastFailureAt = Date.now()
        this.setData({ loading: false, error: e.message || '加载失败', detail: null })
      })
      .finally(() => {
        this._loadPromise = null
      })
    return this._loadPromise
  },

  toggleSubmission(e) {
    const sid = e.currentTarget.dataset.id
    if (!sid) return
    const next = { ...this.data.expanded }
    next[sid] = !next[sid]
    this.setData({ expanded: next })
  },

  goSubmit() {
    if (!this.data.taskId) return
    const taskType = (this.data.detail && this.data.detail.task && this.data.detail.task.taskType) || ''
    wx.navigateTo({ url: `/pages/standard-execution/submit/index?taskId=${this.data.taskId}&taskType=${taskType}` })
  },

  goQuiz() {
    if (!this.data.taskId) return
    wx.navigateTo({ url: `/pages/standard-execution/quiz/index?taskId=${this.data.taskId}` })
  },

  goRecords() {
    wx.navigateTo({ url: '/pages/standard-execution/records/index' })
  },

  _buildRequirementRows(detail) {
    const task = detail && detail.task ? detail.task : {}
    const configs = task.checklistSchema && Array.isArray(task.checklistSchema.items)
      ? task.checklistSchema.items
        .filter((item) => item && (item.requirementTitle || item.requirementDescription || item.submitOptions || item.name))
        .sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0))
      : []
    if (!configs.length) return []

    const taskItems = Array.isArray(detail && detail.taskItems) ? detail.taskItems : []
    const rows = taskItems.length ? taskItems : configs.map((config, idx) => ({
      id: config.id || String(idx),
      status: 'PENDING',
      requirement: {
        id: config.requirementId || config.id || String(idx),
        title: config.requirementTitle || config.name || `要求项 ${idx + 1}`,
        clauseNo: config.clauseNo || '',
      },
    }))

    return rows.map((row, index) => {
      const requirement = row.requirement || {}
      const config = configs.find((item) => item.requirementId && requirement.id && item.requirementId === requirement.id) || configs[index] || {}
      const options = normalizeRequirementSubmitOptions(config.submitOptions)
      return {
        id: row.id || config.id || String(index),
        status: row.status || 'PENDING',
        title: compactText(config.requirementTitle, compactText(requirement.title, compactText(config.name, `要求项 ${index + 1}`))),
        clauseNo: compactText(config.clauseNo, requirement.clauseNo || ''),
        description: compactText(config.requirementDescription, ''),
        required: config.required !== false,
        submitTags: submitTags(options),
        hint: optionHint(config, options),
      }
    })
  },
})
