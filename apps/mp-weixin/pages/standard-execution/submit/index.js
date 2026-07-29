/**
 * 提交任务页 — 按 taskType 渲染对应表单
 *
 * taskType 取值：
 *   TRAINING            培训确认   → 签到表/考核记录上传 + 已阅读确认 + 备注
 *   QUALIFICATION_MATERIAL 资质材料→ 证件正/背面上传 + 证件编号 + 有效期 + 备注
 *   ONBOARDING_ACCESS   上岗准入   → 已了解确认 + 上岗日期 + 备注
 *   INSPECTION_FILL     检查填报   → 检查清单(4项) + 现场照片 + 检查结论 + 备注
 *   RECTIFICATION       整改闭环   → 整改前/后照片 + 整改说明
 *   ARCHIVE_MATERIAL    资料归档   → 归档材料上传 + 材料名称 + 归档说明
 *
 * 通用兜底（未知 taskType）：文字说明 + 图片
 *
 * 流程：
 *   1. 用户填写表单各项
 *   2. 点击"提交" → 逐组上传图片 → 组装 submitText + attachments
 *   3. POST se.submitTask → toast → navigateBack
 */
const se = require('../../../utils/standardExecution')

const MAX_FILES_PER_GROUP = 10
const MAX_SUBMIT_TEXT = 5000

// 检查填报清单固定 4 项（与 demo 一致）
const INSPECTION_CHECKLIST = [
  '外观检查：无破损/变形',
  '润滑检查：油位正常',
  '紧固件检查：无松动',
  '运行测试：运行平稳',
]

const INSPECTION_CONCLUSIONS = ['正常，可继续使用', '有小问题，已现场处理', '需停机维修，已上报']

const REQUIREMENT_SUBMIT_LABEL = {
  TEXT: '文本填写',
  IMAGE: '图片上传',
  FILE: '文件上传',
  STRUCTURED: '结构化填写',
  QUIZ: '题库答题',
  LEARNING: '学习确认',
}

const REQUIREMENT_SUBMIT_OPTIONS = ['TEXT', 'IMAGE', 'FILE', 'STRUCTURED', 'QUIZ', 'LEARNING']
const DEFAULT_REQUIREMENT_SUBMIT_OPTIONS = ['TEXT', 'IMAGE']

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function compactText(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function normalizeRequirementSubmitOptions(raw) {
  const source = Array.isArray(raw) && raw.length ? raw : DEFAULT_REQUIREMENT_SUBMIT_OPTIONS
  const seen = {}
  const normalized = source.filter((option) => {
    if (REQUIREMENT_SUBMIT_OPTIONS.indexOf(option) < 0 || seen[option]) return false
    seen[option] = true
    return true
  })
  return normalized.length ? normalized : DEFAULT_REQUIREMENT_SUBMIT_OPTIONS
}

function submitFlags(options) {
  return options.reduce((acc, option) => {
    acc[option] = true
    return acc
  }, {})
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
  if (options.indexOf('STRUCTURED') >= 0) parts.push(`填写 ${asArray(config.structuredFields).length || 1} 个结构化字段`)
  if (options.indexOf('QUIZ') >= 0) parts.push(`完成题库答题${config.quizQuestionCount ? ` ${config.quizQuestionCount} 题` : ''}`)
  if (options.indexOf('LEARNING') >= 0) parts.push(`确认学习材料 ${asArray(config.learningMaterials).length || 0} 份`)
  return parts.join('；') || '按本要求项配置提交。'
}

function fileDisplayName(file) {
  return file.displayName || file.fileName || file.name || '附件'
}

function isImageFile(file) {
  const name = fileDisplayName(file)
  return file.isImage !== false && (/^image\//.test(file.mimeType || file.type || '') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name || file.tempPath || ''))
}

Page({
  data: {
    taskId: '',
    taskType: '',
    loading: true,
    loadError: '',
    detail: null,
    submitConfig: null,
    submitModeTags: [],
    submitHint: '',
    showText: false,
    showAttachment: false,
    showTaskItems: false,
    showChecklist: false,
    showParameter: false,
    showLearning: false,
    showQuiz: false,
    textLabel: '完成说明',
    textRequired: false,
    textMinLength: 0,
    textMaxLength: MAX_SUBMIT_TEXT,
    attachmentRequired: false,
    attachmentMinCount: 0,
    attachmentMaxCount: 20,
    taskItemInputs: [],
    requirementForms: [],
    learningConfirmed: false,
    quizDone: false,

    // ── 通用文字字段 ──
    submitText: '',          // 备注 / 整改说明 / 归档说明
    submitTextLen: 0,

    // ── 单行文本输入（证件编号/有效期/上岗日期/材料名称）──
    inputValues: {
      certNo: '',
      certExpiry: '',
      onboardDate: '',
      materialName: '',
    },

    // ── 复选框 ──
    checkValues: {
      trainingConfirm: false,   // TRAINING: 已阅读
      onboardConfirm: false,    // ONBOARDING_ACCESS: 已了解
    },
    signatureDone: false,       // ONBOARDING_ACCESS: 签名完成

    // ── 检查清单（INSPECTION_FILL）──
    checklistItems: INSPECTION_CHECKLIST,
    checklistValues: [false, false, false, false],

    // ── 检查结论下拉（INSPECTION_FILL）──
    conclusions: INSPECTION_CONCLUSIONS,
    conclusionIndex: -1,         // wx.picker 选中 index；-1 表示未选

    // ── 图片分组（files1 = 主/唯一组，files2 = 第二组）──
    files1: [],   // TRAINING:签到表  QUALIFICATION:正面  RECTIFICATION:整改前  INSPECTION:现场照片  ARCHIVE:归档材料  通用:图片
    files2: [],   // TRAINING:考核记录 QUALIFICATION:背面  RECTIFICATION:整改后

    submitting: false,
  },

  _saveDraftTimer: null,

  onLoad(opts) {
    const taskId = opts && opts.taskId
    if (!taskId) {
      wx.showToast({ title: '缺少任务 ID', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 1000)
      return
    }
    const taskType = (opts && opts.taskType) || ''
    this.setData({ taskId, taskType })

    // 恢复草稿（仅文字字段）
    const draft = se.loadDraft(taskId)
    if (draft && draft.submitText) {
      this.setData({ submitText: draft.submitText, submitTextLen: draft.submitText.length })
    }
    this._loadDetail(taskId)
  },

  onShow() {
    if (!this.data.taskId) return
    this.setData({ quizDone: this._isQuizDone(this.data.taskId) })
  },

  onUnload() {
    if (this._saveDraftTimer) clearTimeout(this._saveDraftTimer)
  },

  // ── 通用 textarea ──
  inputText(e) {
    const v = e.detail.value || ''
    this.setData({ submitText: v, submitTextLen: v.length })
    if (this._saveDraftTimer) clearTimeout(this._saveDraftTimer)
    this._saveDraftTimer = setTimeout(() => {
      se.saveDraft(this.data.taskId, { submitText: v })
    }, 500)
  },

  inputTaskItem(e) {
    const idx = e.currentTarget.dataset.idx
    if (idx == null) return
    const next = (this.data.taskItemInputs || []).slice()
    next[idx] = Object.assign({}, next[idx], { value: e.detail.value || '' })
    this.setData({ taskItemInputs: next })
  },

  inputRequirementText(e) {
    const idx = e.currentTarget.dataset.idx
    if (idx == null) return
    const next = (this.data.requirementForms || []).slice()
    next[idx] = Object.assign({}, next[idx], { textValue: e.detail.value || '' })
    this.setData({ requirementForms: next })
  },

  inputRequirementStructured(e) {
    const idx = e.currentTarget.dataset.idx
    const fieldIdx = e.currentTarget.dataset.fieldIdx
    if (idx == null || fieldIdx == null) return
    const next = (this.data.requirementForms || []).slice()
    const form = Object.assign({}, next[idx])
    const fields = (form.structuredFields || []).slice()
    fields[fieldIdx] = Object.assign({}, fields[fieldIdx], { value: e.detail.value || '' })
    form.structuredFields = fields
    next[idx] = form
    this.setData({ requirementForms: next })
  },

  toggleRequirementLearning(e) {
    const idx = e.currentTarget.dataset.idx
    if (idx == null) return
    const next = (this.data.requirementForms || []).slice()
    next[idx] = Object.assign({}, next[idx], { learningConfirmed: !next[idx].learningConfirmed })
    this.setData({ requirementForms: next })
  },

  toggleLearningConfirm() {
    this.setData({ learningConfirmed: !this.data.learningConfirmed })
  },

  goQuiz() {
    if (!this.data.taskId) return
    wx.navigateTo({ url: `/pages/standard-execution/quiz/index?taskId=${this.data.taskId}` })
  },

  // ── 单行输入 ──
  inputField(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    const next = Object.assign({}, this.data.inputValues)
    next[key] = e.detail.value || ''
    this.setData({ inputValues: next })
  },

  // ── 简单复选框 ──
  toggleCheck(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    const next = Object.assign({}, this.data.checkValues)
    next[key] = !next[key]
    this.setData({ checkValues: next })
  },

  // ── 签名区（ONBOARDING_ACCESS）── 模拟点击签名
  tapSignature() {
    if (!this.data.checkValues.onboardConfirm) {
      wx.showToast({ title: '请先勾选确认项', icon: 'none' })
      return
    }
    wx.showModal({
      title: '本人签名确认',
      content: '确认以本人身份签署？',
      confirmText: '确认签名',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) this.setData({ signatureDone: true })
      },
    })
  },

  // ── 检查清单 ──
  toggleChecklistItem(e) {
    const idx = e.currentTarget.dataset.idx
    if (idx == null) return
    const next = this.data.checklistValues.slice()
    next[idx] = !next[idx]
    this.setData({ checklistValues: next })
  },

  // ── 检查结论 picker ──
  pickerConclusion(e) {
    this.setData({ conclusionIndex: +e.detail.value })
  },

  // ── 图片选择（group = 1 | 2）──
  chooseImage1() { this._chooseImage('files1') },
  chooseImage2() { this._chooseImage('files2') },

  chooseAttachment() {
    if (!this.data.submitConfig) {
      this.chooseImage1()
      return
    }
    const current = this.data.files1 || []
    const maxFiles = this.data.attachmentMaxCount || MAX_FILES_PER_GROUP
    const remaining = maxFiles - current.length
    if (remaining <= 0) {
      wx.showToast({ title: `最多 ${maxFiles} 份附件`, icon: 'none' })
      return
    }
    if (!wx.chooseMessageFile) {
      this._chooseImage('files1')
      return
    }
    wx.chooseMessageFile({
      count: Math.min(remaining, 9),
      type: 'all',
      success: (r) => {
        const newFiles = (r.tempFiles || []).map((file) => ({
          tempPath: file.path,
          displayName: file.name || '附件',
          fileSize: file.size || 0,
          isImage: /^image\//.test(file.type || '') || /\.(png|jpe?g|gif|webp)$/i.test(file.name || file.path || ''),
          uploaded: false,
        }))
        this.setData({ files1: current.concat(newFiles) })
      },
    })
  },

  chooseRequirementFile(e) {
    const idx = e.currentTarget.dataset.idx
    if (idx == null) return
    const forms = this.data.requirementForms || []
    const form = forms[idx]
    if (!form) return
    const current = form.files || []
    const maxFiles = form.attachmentMaxCount || MAX_FILES_PER_GROUP
    const remaining = maxFiles - current.length
    if (remaining <= 0) {
      wx.showToast({ title: `最多 ${maxFiles} 份附件`, icon: 'none' })
      return
    }

    const appendFiles = (files) => {
      const next = (this.data.requirementForms || []).slice()
      const nextForm = Object.assign({}, next[idx])
      nextForm.files = (nextForm.files || []).concat(files)
      next[idx] = nextForm
      this.setData({ requirementForms: next })
    }

    if (wx.chooseMessageFile) {
      wx.chooseMessageFile({
        count: Math.min(remaining, 9),
        type: form.submitFlags && form.submitFlags.FILE ? 'all' : 'image',
        success: (r) => {
          appendFiles((r.tempFiles || []).map((file) => ({
            tempPath: file.path,
            displayName: file.name || '附件',
            fileSize: file.size || 0,
            mimeType: file.type || '',
            isImage: isImageFile(file),
            uploaded: false,
          })))
        },
      })
      return
    }

    wx.chooseImage({
      count: Math.min(remaining, 9),
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (r) => {
        appendFiles((r.tempFilePaths || []).map((p) => ({
          tempPath: p,
          displayName: '图片',
          isImage: true,
          uploaded: false,
        })))
      },
    })
  },

  _chooseImage(groupKey) {
    const current = this.data[groupKey] || []
    const maxFiles = this.data.submitConfig && groupKey === 'files1' ? this.data.attachmentMaxCount : MAX_FILES_PER_GROUP
    const remaining = maxFiles - current.length
    if (remaining <= 0) {
      wx.showToast({ title: `最多 ${maxFiles} 份附件`, icon: 'none' })
      return
    }
    wx.chooseImage({
      count: Math.min(remaining, 9),
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (r) => {
        const newFiles = (r.tempFilePaths || []).map((p) => ({ tempPath: p, uploaded: false }))
        const upd = {}
        upd[groupKey] = current.concat(newFiles)
        this.setData(upd)
      },
    })
  },

  removeFile1(e) { this._removeFile('files1', e.currentTarget.dataset.idx) },
  removeFile2(e) { this._removeFile('files2', e.currentTarget.dataset.idx) },

  removeRequirementFile(e) {
    const idx = e.currentTarget.dataset.idx
    const fileIdx = e.currentTarget.dataset.fileIdx
    if (idx == null || fileIdx == null) return
    const next = (this.data.requirementForms || []).slice()
    const form = Object.assign({}, next[idx])
    const files = (form.files || []).slice()
    files.splice(fileIdx, 1)
    form.files = files
    next[idx] = form
    this.setData({ requirementForms: next })
  },

  _removeFile(groupKey, idx) {
    if (idx == null) return
    const next = (this.data[groupKey] || []).slice()
    next.splice(idx, 1)
    const upd = {}
    upd[groupKey] = next
    this.setData(upd)
  },

  previewImage1(e) { this._previewImage('files1', e.currentTarget.dataset.idx) },
  previewImage2(e) { this._previewImage('files2', e.currentTarget.dataset.idx) },

  previewRequirementFile(e) {
    const idx = e.currentTarget.dataset.idx
    const fileIdx = e.currentTarget.dataset.fileIdx
    const form = (this.data.requirementForms || [])[idx]
    if (!form) return
    const files = form.files || []
    const file = files[fileIdx]
    if (!file || !isImageFile(file)) return
    const urls = files.filter(isImageFile).map((f) => f.tempPath)
    wx.previewImage({ urls, current: file.tempPath })
  },

  _previewImage(groupKey, idx) {
    if (idx == null) return
    const urls = (this.data[groupKey] || []).map((f) => f.tempPath)
    wx.previewImage({ urls, current: urls[idx] })
  },

  // ── 提交 ──
  submit() {
    if (this.data.submitting) return
    const type = this.data.taskType

    // 1. 校验
    const err = this._validate(type)
    if (err) { wx.showToast({ title: err, icon: 'none' }); return }

    this.setData({ submitting: true })

    // 2. 上传附件（新模型按要求项分组，旧模型仍走 files1/files2）
    this._uploadRequirementFiles()
      .then(() => this._syncRequirementProgress())
      .then(() => this._uploadGroup('files1'))
      .then(() => this._uploadGroup('files2'))
      .then(() => {
        // 3. 组装提交内容
        const submitText = this._buildSubmitText(type)
        const attachments = [
          ...this._collectRequirementAttachments(),
          ...(this.data.files1 || []).filter(f => f.uploaded && f.fileUrl)
            .map(f => ({ fileName: f.fileName, fileUrl: f.fileUrl, fileSize: f.fileSize, mimeType: f.mimeType })),
          ...(this.data.files2 || []).filter(f => f.uploaded && f.fileUrl)
            .map(f => ({ fileName: f.fileName, fileUrl: f.fileUrl, fileSize: f.fileSize, mimeType: f.mimeType })),
        ]
        const submitDataJson = this._buildRequirementSubmitDataJson()
        return se.submitTask(this.data.taskId, { submitText, attachments, submitDataJson })
      })
      .then(() => {
        wx.hideLoading()
        se.clearDraft(this.data.taskId)
        wx.showToast({ title: '已提交，待审核', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 1200)
      })
      .catch((e) => {
        wx.hideLoading()
        wx.showToast({ title: e.message || '提交失败', icon: 'none' })
      })
      .finally(() => this.setData({ submitting: false }))
  },

  _validate(type) {
    if (this.data.submitConfig) return this._validateDynamic()
    const { files1, files2, submitText, inputValues, checkValues, checklistValues, conclusionIndex } = this.data
    if (type === 'TRAINING') {
      if (!files1.length) return '请上传培训签到表'
      if (!files2.length) return '请上传考核记录'
      if (!checkValues.trainingConfirm) return '请勾选已阅读确认'
    } else if (type === 'QUALIFICATION_MATERIAL') {
      if (!files1.length) return '请上传证件正面照片'
      if (!files2.length) return '请上传证件背面照片'
      if (!(inputValues.certNo || '').trim()) return '请填写证件编号'
      if (!(inputValues.certExpiry || '').trim()) return '请填写有效期'
    } else if (type === 'ONBOARDING_ACCESS') {
      if (!checkValues.onboardConfirm) return '请勾选已了解上岗要求'
      if (!(inputValues.onboardDate || '').trim()) return '请填写上岗日期'
      if (!this.data.signatureDone) return '请完成本人签名确认'
    } else if (type === 'INSPECTION_FILL') {
      if (conclusionIndex < 0) return '请选择检查结论'
      if (!files1.length) return '请上传现场照片'
    } else if (type === 'RECTIFICATION') {
      if (!files1.length) return '请上传整改前照片'
      if (!files2.length) return '请上传整改后照片'
      if (!(submitText || '').trim()) return '请填写整改说明'
    } else if (type === 'ARCHIVE_MATERIAL') {
      if (!files1.length) return '请上传归档材料'
      if (!(inputValues.materialName || '').trim()) return '请填写材料名称'
    } else {
      // 通用兜底
      if (!(submitText || '').trim()) return '请填写文字说明'
      if (!files1.length) return '请至少上传 1 张图片'
    }
    return null
  },

  _buildSubmitText(type) {
    if (this.data.submitConfig) return this._buildDynamicSubmitText()
    const { submitText, inputValues, checkValues, checklistValues, conclusionIndex, conclusions } = this.data
    const lines = []
    if (type === 'TRAINING') {
      lines.push('【培训确认】')
      lines.push('已阅读并确认培训内容：✓')
      if (submitText) lines.push('备注：' + submitText)
    } else if (type === 'QUALIFICATION_MATERIAL') {
      lines.push('【资质材料】')
      if (inputValues.certNo) lines.push('证件编号：' + inputValues.certNo)
      if (inputValues.certExpiry) lines.push('有效期：' + inputValues.certExpiry)
      if (submitText) lines.push('备注：' + submitText)
    } else if (type === 'ONBOARDING_ACCESS') {
      lines.push('【上岗准入】')
      lines.push('已了解本岗位全部操作规范与安全要求：✓')
      if (inputValues.onboardDate) lines.push('上岗日期：' + inputValues.onboardDate)
      lines.push('本人签名确认：✓')
    } else if (type === 'INSPECTION_FILL') {
      lines.push('【检查填报】')
      INSPECTION_CHECKLIST.forEach(function(item, i) {
        lines.push((checklistValues[i] ? '☑ ' : '☐ ') + item)
      })
      if (conclusionIndex >= 0) lines.push('检查结论：' + conclusions[conclusionIndex])
      if (submitText) lines.push('备注：' + submitText)
    } else if (type === 'RECTIFICATION') {
      lines.push('【整改闭环】')
      if (submitText) lines.push('整改说明：' + submitText)
    } else if (type === 'ARCHIVE_MATERIAL') {
      lines.push('【资料归档】')
      if (inputValues.materialName) lines.push('材料名称：' + inputValues.materialName)
      if (submitText) lines.push('归档说明：' + submitText)
    } else {
      return (submitText || '').trim()
    }
    return lines.join('\n')
  },

  _loadDetail(taskId) {
    this.setData({ loading: true, loadError: '' })
    se.getTaskDetail(taskId)
      .then((detail) => {
        const task = detail && detail.task ? detail.task : {}
        const config = task.submitFormConfig || se.submitForms.submitFormConfigFor(detail)
        const modes = config.modes || []
        const text = config.text || {}
        const attachment = config.attachment || {}
        const taskItems = (detail && detail.taskItems) || []
        const requirementForms = this._buildRequirementForms(detail)
        this.setData({
          loading: false,
          detail,
          taskType: task.taskType || this.data.taskType,
          submitConfig: config,
          submitModeTags: se.submitForms.modeTags(config),
          submitHint: config.employeeHint || task.submitRequirement || '请按任务要求提交。',
          showText: modes.indexOf('TEXT') >= 0,
          showAttachment: modes.indexOf('ATTACHMENT') >= 0,
          showTaskItems: modes.indexOf('TASK_ITEMS') >= 0,
          showChecklist: modes.indexOf('CHECKLIST') >= 0,
          showParameter: modes.indexOf('PARAMETER') >= 0,
          showLearning: modes.indexOf('LEARNING') >= 0,
          showQuiz: modes.indexOf('QUIZ') >= 0,
          textLabel: text.label || '完成说明',
          textRequired: !!text.required,
          textMinLength: Number(text.minLength || 0),
          textMaxLength: Number(text.maxLength || MAX_SUBMIT_TEXT),
          attachmentRequired: !!attachment.required,
          attachmentMinCount: Number(attachment.minCount || 0),
          attachmentMaxCount: Number(attachment.maxCount || 20),
          requirementForms,
          taskItemInputs: taskItems.map((item, idx) => ({
            id: item.id || String(idx),
            title: (item.requirement && item.requirement.title) || item.title || `检查项 ${idx + 1}`,
            clauseNo: item.requirement && item.requirement.clauseNo,
            value: '',
          })),
          quizDone: this._isQuizDone(taskId),
        })
      })
      .catch((e) => {
        // 拉详情失败时保留旧 taskType 分支，避免员工端被新契约阻塞。
        this.setData({ loading: false, loadError: e.message || '配置加载失败', submitConfig: null })
      })
  },

  _buildRequirementForms(detail) {
    const task = detail && detail.task ? detail.task : {}
    const configs = task.checklistSchema && Array.isArray(task.checklistSchema.items)
      ? task.checklistSchema.items
        .filter((item) => item && (item.requirementTitle || item.requirementDescription || item.submitOptions || item.name))
        .sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0))
      : []
    if (!configs.length) return []

    const taskItems = Array.isArray(detail && detail.taskItems) ? detail.taskItems : []
    const rows = taskItems.length ? taskItems : configs.map((config, idx) => ({
      id: '',
      requirement: {
        id: config.requirementId || config.id || String(idx),
        title: config.requirementTitle || config.name || `要求项 ${idx + 1}`,
        clauseNo: config.clauseNo || '',
        source: { title: config.sourceTitle || '' },
      },
    }))

    return rows.map((row, idx) => {
      const requirement = row.requirement || {}
      const config = this._findRequirementConfig(configs, requirement.id, idx)
      const options = normalizeRequirementSubmitOptions(config && config.submitOptions)
      const maxCount = Number((config && config.attachmentMaxCount) || 20)
      const minCount = (options.indexOf('IMAGE') >= 0 || options.indexOf('FILE') >= 0)
        ? (config && config.attachmentRequired === false ? Number(config.attachmentMinCount || 0) : Math.max(1, Number((config && config.attachmentMinCount) || 1)))
        : 0
      const structuredFields = asArray(config && config.structuredFields).map((field, fieldIdx) => ({
        id: field.id || String(fieldIdx),
        name: field.name || `填写项 ${fieldIdx + 1}`,
        fieldType: field.fieldType || 'TEXT',
        required: field.required !== false,
        validation: field.validation || '',
        value: '',
      }))
      return {
        id: (config && config.id) || row.id || String(idx),
        taskItemId: row.id || '',
        requirementId: (config && config.requirementId) || requirement.id || '',
        title: compactText(config && config.requirementTitle, compactText(requirement.title, compactText(config && config.name, `要求项 ${idx + 1}`))),
        description: compactText(config && config.requirementDescription, requirement.requirementText || ''),
        clauseNo: compactText(config && config.clauseNo, requirement.clauseNo || ''),
        sourceTitle: compactText(config && config.sourceTitle, (requirement.source && requirement.source.title) || ''),
        required: !config || config.required !== false,
        submitOptions: options,
        submitFlags: submitFlags(options),
        submitTags: submitTags(options),
        hint: optionHint(config || {}, options),
        textPrompt: compactText(config && config.textPrompt, '请填写执行说明、结果或异常情况'),
        textValue: '',
        attachmentRequired: minCount > 0,
        attachmentMinCount: minCount,
        attachmentMaxCount: maxCount,
        attachmentHint: compactText(config && config.attachmentHint, ''),
        structuredFields,
        quizBankId: (config && config.quizBankId) || task.quizBankId || '',
        quizQuestionCount: Number((config && config.quizQuestionCount) || 0),
        quizPassScore: Number((config && config.quizPassScore) || 0),
        learningMaterials: asArray(config && config.learningMaterials),
        learningConfirmed: false,
        files: [],
      }
    })
  },

  _findRequirementConfig(configs, requirementId, index) {
    return configs.find((config) => config.requirementId && requirementId && config.requirementId === requirementId)
      || configs[index]
      || null
  },

  _validateDynamic() {
    if ((this.data.requirementForms || []).length > 0) return this._validateRequirementForms()
    const text = (this.data.submitText || '').trim()
    if (this.data.textRequired && text.length < this.data.textMinLength) {
      return this.data.textMinLength > 1 ? `${this.data.textLabel}至少 ${this.data.textMinLength} 字` : `请填写${this.data.textLabel}`
    }
    if (this.data.attachmentRequired && (this.data.files1 || []).length < this.data.attachmentMinCount) {
      return `请至少上传 ${this.data.attachmentMinCount || 1} 份附件`
    }
    if (this.data.showTaskItems) {
      const empty = (this.data.taskItemInputs || []).find((item) => !(item.value || '').trim())
      if (empty) return '请填写全部检查项'
    }
    if (this.data.showLearning && this.data.submitConfig.learning && this.data.submitConfig.learning.requiresConfirmation && !this.data.learningConfirmed) {
      return '请确认已阅读学习材料'
    }
    if (this.data.showQuiz && this.data.submitConfig.quiz && this.data.submitConfig.quiz.required && !this.data.quizDone) {
      return '请先完成题库答题'
    }
    return null
  },

  _validateRequirementForms() {
    const forms = this.data.requirementForms || []
    for (let i = 0; i < forms.length; i++) {
      const form = forms[i]
      const prefix = `${i + 1}. ${form.title}`
      if (form.required !== false && form.submitFlags && form.submitFlags.TEXT && !(form.textValue || '').trim()) {
        return `请填写${prefix}的文本说明`
      }
      if (form.submitFlags && form.submitFlags.STRUCTURED) {
        const missingField = (form.structuredFields || []).find((field) => field.required !== false && !(field.value || '').trim())
        if (missingField) return `请填写${prefix}的${missingField.name}`
      }
      if (form.attachmentMinCount > 0 && (form.files || []).length < form.attachmentMinCount) {
        return `${prefix}至少上传 ${form.attachmentMinCount} 份附件`
      }
      if (form.required !== false && form.submitFlags && form.submitFlags.LEARNING && !form.learningConfirmed) {
        return `请确认${prefix}的学习材料`
      }
      if (form.required !== false && form.submitFlags && form.submitFlags.QUIZ && !this.data.quizDone) {
        return `请完成${prefix}的题库答题`
      }
    }
    return null
  },

  _buildDynamicSubmitText() {
    if ((this.data.requirementForms || []).length > 0) return this._buildRequirementSubmitText()
    const lines = []
    const task = this.data.detail && this.data.detail.task
    lines.push(`【${se.submitForms.taskTypeLabel(task && task.taskType)}】`)
    if (this.data.showTaskItems) {
      lines.push('【检查项填写】')
      ;(this.data.taskItemInputs || []).forEach((item, idx) => {
        const prefix = item.clauseNo ? `[${item.clauseNo}] ` : ''
        lines.push(`${idx + 1}. ${prefix}${item.title}：${(item.value || '').trim()}`)
      })
    }
    if (this.data.showChecklist) lines.push('【清单勾选】已按要求完成清单核对')
    if (this.data.showParameter) lines.push('【参数填写】已按要求完成参数记录')
    if (this.data.showLearning && this.data.learningConfirmed) lines.push('【学习确认】已阅读并确认学习材料')
    if (this.data.showQuiz) lines.push(`【题库答题】${this.data.quizDone ? '已完成题库答题' : '未完成题库答题'}`)
    if ((this.data.submitText || '').trim()) {
      lines.push(`【${this.data.textLabel || '完成说明'}】`)
      lines.push((this.data.submitText || '').trim())
    }
    return lines.join('\n')
  },

  _buildRequirementSubmitText() {
    const lines = ['【按要求项提交】']
    ;(this.data.requirementForms || []).forEach((form, idx) => {
      const title = `${idx + 1}. ${form.clauseNo ? `[${form.clauseNo}] ` : ''}${form.title}`
      lines.push(title)
      if ((form.textValue || '').trim()) lines.push(`说明：${(form.textValue || '').trim()}`)
      ;(form.structuredFields || []).forEach((field) => {
        if ((field.value || '').trim()) lines.push(`${field.name}：${(field.value || '').trim()}`)
      })
      const uploadedCount = (form.files || []).filter((file) => file.uploaded && file.fileUrl).length
      if (uploadedCount > 0) lines.push(`附件：${uploadedCount} 个`)
      if (form.submitFlags && form.submitFlags.LEARNING) lines.push(`学习确认：${form.learningConfirmed ? '已确认' : '未确认'}`)
      if (form.submitFlags && form.submitFlags.QUIZ) lines.push(`题库答题：${this.data.quizDone ? '已完成' : '未完成'}`)
    })
    if ((this.data.submitText || '').trim()) {
      lines.push('【补充说明】')
      lines.push((this.data.submitText || '').trim())
    }
    return lines.join('\n')
  },

  _isQuizDone(taskId) {
    try {
      return !!wx.getStorageSync(`se_quiz_done_${taskId}`)
    } catch (e) {
      return false
    }
  },

  _uploadRequirementFiles() {
    const forms = this.data.requirementForms || []
    if (!forms.length) return Promise.resolve()
    let formIndex = 0
    let fileIndex = 0
    const next = () => {
      while (formIndex < forms.length) {
        const currentForms = this.data.requirementForms || []
        const form = currentForms[formIndex]
        const files = (form && form.files) || []
        while (fileIndex < files.length) {
          const file = files[fileIndex]
          if (file.uploaded && file.fileUrl) {
            fileIndex++
            continue
          }
          wx.showLoading({ title: `上传附件 (${formIndex + 1}/${forms.length})`, mask: true })
          return se.uploadFile(this.data.taskId, file.tempPath).then((d) => {
            const updatedForms = (this.data.requirementForms || []).slice()
            const updatedForm = Object.assign({}, updatedForms[formIndex])
            const updatedFiles = (updatedForm.files || []).slice()
            updatedFiles[fileIndex] = Object.assign({}, file, {
              uploaded: true,
              fileUrl: d.fileUrl,
              fileName: d.fileName || fileDisplayName(file),
              fileSize: d.fileSize || file.fileSize || 0,
              mimeType: d.mimeType || file.mimeType || '',
              displayName: d.fileName || fileDisplayName(file),
            })
            updatedForm.files = updatedFiles
            updatedForms[formIndex] = updatedForm
            this.setData({ requirementForms: updatedForms })
            fileIndex++
            return next()
          })
        }
        formIndex++
        fileIndex = 0
      }
      return Promise.resolve()
    }
    return next()
  },

  _syncRequirementProgress() {
    const forms = this.data.requirementForms || []
    const withTaskItems = forms.filter((form) => form.taskItemId)
    if (!withTaskItems.length) return Promise.resolve()
    let index = 0
    const next = () => {
      if (index >= withTaskItems.length) return Promise.resolve()
      const form = withTaskItems[index]
      const fileUrls = (form.files || []).filter((file) => file.uploaded && file.fileUrl).map((file) => file.fileUrl)
      const noteParts = []
      if ((form.textValue || '').trim()) noteParts.push((form.textValue || '').trim())
      ;(form.structuredFields || []).forEach((field) => {
        if ((field.value || '').trim()) noteParts.push(`${field.name}：${(field.value || '').trim()}`)
      })
      if (form.submitFlags && form.submitFlags.LEARNING) noteParts.push(`学习确认：${form.learningConfirmed ? '已确认' : '未确认'}`)
      if (form.submitFlags && form.submitFlags.QUIZ) noteParts.push(`题库答题：${this.data.quizDone ? '已完成' : '未完成'}`)
      return se.updateTaskItem(this.data.taskId, form.taskItemId, {
        status: 'DONE',
        note: noteParts.join('\n') || '已按要求项提交。',
        fileUrls,
      }).then(() => {
        index++
        return next()
      })
    }
    return next()
  },

  _collectRequirementAttachments() {
    const attachments = []
    ;(this.data.requirementForms || []).forEach((form) => {
      ;(form.files || []).forEach((file) => {
        if (!file.uploaded || !file.fileUrl) return
        attachments.push({
          fileName: file.fileName || fileDisplayName(file),
          fileUrl: file.fileUrl,
          fileSize: file.fileSize,
          mimeType: file.mimeType,
        })
      })
    })
    return attachments
  },

  _buildRequirementSubmitDataJson() {
    const forms = this.data.requirementForms || []
    if (!forms.length) return undefined
    const requirementForms = {}
    forms.forEach((form) => {
      const key = form.taskItemId || form.requirementId || form.id
      if (!key) return
      const attachments = (form.files || [])
        .filter((file) => file.uploaded && file.fileUrl)
        .map((file) => ({
          fileName: file.fileName || fileDisplayName(file),
          fileUrl: file.fileUrl,
          fileSize: file.fileSize,
          mimeType: file.mimeType,
        }))
      requirementForms[key] = {
        taskItemId: form.taskItemId,
        requirementId: form.requirementId,
        title: form.title,
        clauseNo: form.clauseNo,
        submitOptions: form.submitOptions,
        text: (form.textValue || '').trim(),
        structuredFields: (form.structuredFields || []).reduce((acc, field) => {
          const fieldKey = field.id || field.name
          if (fieldKey) acc[fieldKey] = (field.value || '').trim()
          return acc
        }, {}),
        structuredFieldItems: (form.structuredFields || []).map((field) => ({
          id: field.id,
          name: field.name,
          fieldType: field.fieldType,
          value: (field.value || '').trim(),
        })),
        learningConfirmed: !!form.learningConfirmed,
        quizDone: !!this.data.quizDone,
        attachmentCount: attachments.length,
        attachments,
      }
    })
    return {
      requirementSubmitConfigs: forms.map((form, index) => ({
        id: form.id,
        taskItemId: form.taskItemId,
        requirementId: form.requirementId,
        title: form.title,
        clauseNo: form.clauseNo,
        required: form.required !== false,
        submitOptions: form.submitOptions,
        sort: index + 1,
      })),
      requirementForms,
    }
  },

  _uploadGroup(groupKey) {
    const files = this.data[groupKey] || []
    if (!files.length) return Promise.resolve()
    const total = files.length
    let i = 0
    const next = () => {
      if (i >= total) return Promise.resolve()
      const f = files[i]
      if (f.uploaded && f.fileUrl) { i++; return next() }
      wx.showLoading({ title: `上传中 (${i + 1}/${total})`, mask: true })
      return se.uploadFile(this.data.taskId, f.tempPath).then((d) => {
        const updated = (this.data[groupKey] || []).slice()
        updated[i] = Object.assign({}, f, { uploaded: true, fileUrl: d.fileUrl, fileName: d.fileName, fileSize: d.fileSize, mimeType: d.mimeType })
        const upd = {}
        upd[groupKey] = updated
        this.setData(upd)
        i++
        return next()
      })
    }
    return next()
  },
})
