/**
 * T12 submitFormConfig helpers for the employee mini program.
 *
 * The backend returns submitFormConfig for new tasks. Older tasks and cached
 * list rows still fall back to taskType/taskItems so the existing employee flow
 * remains compatible.
 */

const SUBMIT_MODE_LABEL = {
  TEXT: '文字填写',
  ATTACHMENT: '附件上传',
  TASK_ITEMS: '检查项填写',
  CHECKLIST: '清单勾选',
  PARAMETER: '参数填写',
  LEARNING: '学习确认',
  QUIZ: '题库答题',
}

const TASK_TYPE_LABEL = {
  TRAINING: '培训确认',
  QUALIFICATION_MATERIAL: '资质材料',
  ONBOARDING_ACCESS: '上岗准入',
  INSPECTION_FILL: '检查填报',
  RECTIFICATION: '整改闭环',
  ARCHIVE_MATERIAL: '资料归档',
  DOCUMENT_UPLOAD: '资料上传',
  PHOTO: '现场拍照',
}

const FILE_REQUIRED_TASK_TYPES = {
  PHOTO: true,
  DOCUMENT_UPLOAD: true,
  QUALIFICATION_MATERIAL: true,
  ARCHIVE_MATERIAL: true,
  TRAINING: true,
  INSPECTION_FILL: true,
  RECTIFICATION: true,
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function textOrFallback(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function normalizeModes(modes) {
  const seen = {}
  return asArray(modes).filter((mode) => {
    if (!SUBMIT_MODE_LABEL[mode] || seen[mode]) return false
    seen[mode] = true
    return true
  })
}

function attachmentAcceptFor(taskType) {
  if (taskType === 'PHOTO' || taskType === 'INSPECTION_FILL' || taskType === 'RECTIFICATION') {
    return ['image/*']
  }
  return ['image/*', 'application/pdf', '.doc', '.docx', '.xls', '.xlsx']
}

function countMaterials(task) {
  if (!task) return 0
  if (Array.isArray(task.materials)) return task.materials.length
  if (Array.isArray(task.learningMaterials)) return task.learningMaterials.length
  if (Array.isArray(task.attachments)) return task.attachments.length
  return 0
}

function inferStructuredMode(task, taskItemCount) {
  if (taskItemCount > 0) return 'TASK_ITEMS'
  if (task && isObject(task.checklistSchema)) return 'CHECKLIST'
  if (task && isObject(task.parameterSchema)) return 'PARAMETER'
  return null
}

function buildFallback(task, taskItemCount) {
  const safeTask = task || {}
  const taskType = safeTask.taskType || ''
  const structuredType = inferStructuredMode(safeTask, taskItemCount)
  const modes = ['TEXT']
  if (FILE_REQUIRED_TASK_TYPES[taskType]) modes.push('ATTACHMENT')
  if (structuredType) modes.push(structuredType)
  if (taskType === 'TRAINING' || countMaterials(safeTask) > 0) modes.push('LEARNING')
  if (safeTask.quizBankId) modes.push('QUIZ')
  if (modes.length === 1 && !safeTask.submitRequirement) modes.push('ATTACHMENT')

  const attachmentRequired = !!FILE_REQUIRED_TASK_TYPES[taskType]
  return {
    version: 'T12_SUBMIT_FORM_V1',
    modes: normalizeModes(modes),
    text: {
      required: !attachmentRequired,
      label: '完成说明',
      minLength: !attachmentRequired ? 1 : 0,
      maxLength: 5000,
    },
    attachment: {
      required: attachmentRequired,
      minCount: attachmentRequired ? 1 : 0,
      maxCount: 20,
      accept: attachmentAcceptFor(taskType),
      reason: attachmentRequired ? '此类任务需要上传佐证材料' : null,
    },
    structured: {
      type: structuredType,
      itemCount: taskItemCount || 0,
    },
    learning: {
      materialCount: countMaterials(safeTask),
      requiresConfirmation: taskType === 'TRAINING' || countMaterials(safeTask) > 0,
    },
    quiz: {
      required: !!safeTask.quizBankId,
      quizBankId: safeTask.quizBankId || null,
    },
    employeeHint: safeTask.submitRequirement || '请按任务要求提交文字说明与必要附件。',
    source: 'fallback',
  }
}

function normalizeConfig(rawConfig, task, taskItemCount) {
  const fallback = buildFallback(task, taskItemCount)
  if (!isObject(rawConfig)) return fallback

  const modes = normalizeModes(rawConfig.modes)
  const merged = {
    version: rawConfig.version || 'T12_SUBMIT_FORM_V1',
    modes: modes.length ? modes : fallback.modes,
    text: Object.assign({}, fallback.text, isObject(rawConfig.text) ? rawConfig.text : {}),
    attachment: Object.assign({}, fallback.attachment, isObject(rawConfig.attachment) ? rawConfig.attachment : {}),
    structured: Object.assign({}, fallback.structured, isObject(rawConfig.structured) ? rawConfig.structured : {}),
    learning: Object.assign({}, fallback.learning, isObject(rawConfig.learning) ? rawConfig.learning : {}),
    quiz: Object.assign({}, fallback.quiz, isObject(rawConfig.quiz) ? rawConfig.quiz : {}),
    employeeHint: textOrFallback(rawConfig.employeeHint, fallback.employeeHint),
    source: 'explicit',
  }

  if (merged.structured && merged.structured.type && merged.modes.indexOf(merged.structured.type) < 0) {
    merged.modes.push(merged.structured.type)
  }
  if (merged.quiz && merged.quiz.quizBankId && merged.modes.indexOf('QUIZ') < 0) merged.modes.push('QUIZ')
  return merged
}

function detailTask(detailOrTask) {
  if (detailOrTask && detailOrTask.task) return detailOrTask.task
  return detailOrTask || {}
}

function taskItemCount(detailOrTask) {
  if (detailOrTask && Array.isArray(detailOrTask.taskItems)) return detailOrTask.taskItems.length
  const task = detailTask(detailOrTask)
  return Array.isArray(task.taskItems) ? task.taskItems.length : 0
}

function submitFormConfigFor(detailOrTask) {
  const task = detailTask(detailOrTask)
  return normalizeConfig(task.submitFormConfig, task, taskItemCount(detailOrTask))
}

function modeTags(config) {
  return normalizeModes(config && config.modes).map((mode) => ({
    mode,
    label: SUBMIT_MODE_LABEL[mode] || mode,
  }))
}

function summary(config) {
  const tags = modeTags(config).map((item) => item.label)
  return tags.length ? tags.join(' + ') : '文字填写'
}

function taskTypeLabel(type) {
  return TASK_TYPE_LABEL[type] || type || '未指定'
}

function boolLabel(value) {
  return value ? '必填' : '选填'
}

function buildFieldRows(detail) {
  const task = detailTask(detail)
  const requirement = (detail && detail.requirement) || task.requirement || {}
  const source = requirement.source || {}
  const assignee = (detail && detail.myAssignee) || {}
  const config = submitFormConfigFor(detail)
  const attachment = config.attachment || {}
  const rows = [
    { key: 'title', label: '标题', value: task.title || '未命名任务' },
    { key: 'taskType', label: '任务类型', value: taskTypeLabel(task.taskType) },
    { key: 'source', label: '文档来源', value: source.title || requirement.sourceTitle || '未关联标准' },
    { key: 'generated', label: '生成内容', value: task.description || requirement.title || '无', multiline: true },
    { key: 'assignee', label: '执行人', value: assignee.assigneeName || assignee.userName || assignee.assigneeId || '当前员工' },
    { key: 'reviewer', label: '审核人', value: task.reviewerName || task.reviewerId || '企业管理员' },
    { key: 'deadline', label: '截止时间', value: task.deadlineAt || '未设置' },
    { key: 'submitForm', label: '提交形式', value: summary(config) },
    { key: 'submitRequirement', label: '提交要求', value: task.submitRequirement || config.employeeHint || '无', multiline: true },
    {
      key: 'materials',
      label: '材料清单',
      value: `附件${boolLabel(attachment.required)}，至少 ${attachment.minCount || 0} 份，最多 ${attachment.maxCount || 20} 份`,
      multiline: true,
    },
    { key: 'status', label: '状态', value: assignee.statusLabel || assignee.status || task.status || '未知' },
    { key: 'timeline', label: '生命周期', value: lifecycleSummary(detail), multiline: true },
  ]
  return rows
}

function lifecycleRows(detail) {
  const task = detailTask(detail)
  const assignee = (detail && detail.myAssignee) || {}
  const submissions = asArray(detail && detail.mySubmissions)
  const latest = submissions[0] || {}
  const rows = [
    { key: 'created', label: '创建', value: task.createdAt || '暂无时间' },
    { key: 'approved', label: '审批', value: task.approvedAt || task.reviewedAt || '暂无时间' },
    { key: 'assigned', label: '派发', value: task.publishedAt || assignee.assignedAt || '暂无时间' },
    { key: 'submitted', label: '提交', value: latest.submittedAt || '暂无提交' },
    { key: 'reviewed', label: '审核', value: latest.reviewedAt || latest.reviewComment || '暂无审核' },
  ]
  return rows
}

function lifecycleSummary(detail) {
  return lifecycleRows(detail).map((row) => `${row.label}：${row.value}`).join('\n')
}

module.exports = {
  SUBMIT_MODE_LABEL,
  TASK_TYPE_LABEL,
  submitFormConfigFor,
  modeTags,
  summary,
  taskTypeLabel,
  buildFieldRows,
  lifecycleRows,
}
