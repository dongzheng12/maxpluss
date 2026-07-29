/**
 * standard-execution 小程序员工端 API 封装
 *
 * 包一层 request()，不裸调 wx.request。
 * Page 层只用 todo/review/done/closed 四种企业员工端逻辑名。
 *
 * 后端接口详见 services/api/src/standard-execution/mpTaskRoutes.ts
 * 和 mpSubmitRoutes.ts。
 */
const request = require('./request')
const config = require('./config')
const session = require('./session')
const submitForms = require('./submitFormConfig')
const dateUtil = require('./date')

// ─── Tab → assignee.status 列表（与后端 mpTaskRoutes 映射保持一致）──

const TAB_KEYS = ['todo', 'review', 'done', 'closed']

// ─── 文案/颜色映射（前端展示用）──────────────────

const TASK_STATUS_LABEL = {
  PUBLISHED: '已发布',
  COMPLETED: '已完成',
  OVERDUE: '已逾期',
  // DRAFT/CANCELLED 员工不可见，不映射
}

const ASSIGNEE_STATUS_LABEL = {
  PENDING: '待开始',
  IN_PROGRESS: '进行中',
  PENDING_REVIEW: '待审核',
  REJECTED: '已驳回',
  COMPLETED: '已完成',
  OVERDUE: '已逾期',
}

const SUBMISSION_STATUS_LABEL = {
  SUBMITTED: '审核中',
  APPROVED: '已通过',
  REJECTED: '已驳回',
}

const SUBMISSION_STATUS_COLOR = {
  SUBMITTED: '#fa8c16',
  APPROVED: '#52c41a',
  REJECTED: '#f5222d',
}

const RECORD_STATUS_LABEL = {
  VALID: '有效',
  EXPIRED: '已过期',
  VOID: '已作废',
}

// ─── API 封装 ────────────────────────────────────────

function normalizeListTask(item) {
  const task = (item && item.task) || {}
  const basis = Array.isArray(task.basis) ? task.basis : []
  const firstBasis = basis[0] || {}
  const requirement = task.requirement || {
    id: firstBasis.requirementId || '',
    title: firstBasis.title || '未关联检查点',
    clauseNo: firstBasis.clauseNo || null,
  }
  return {
    ...item,
    submittedAt: dateUtil.formatDate(item && item.submittedAt),
    reviewedAt: dateUtil.formatDate(item && item.reviewedAt),
    updatedAt: dateUtil.formatDate(item && item.updatedAt),
    task: {
      ...task,
      deadlineAt: dateUtil.formatDate(task.deadlineAt),
      createdAt: dateUtil.formatDate(task.createdAt),
      updatedAt: dateUtil.formatDate(task.updatedAt),
      requirement,
      submitFormConfig: submitForms.submitFormConfigFor(task),
    },
    submitFormSummary: submitForms.summary(submitForms.submitFormConfigFor(task)),
  }
}

function normalizeDetail(data) {
  if (!data || !data.task) return data
  const task = {
    ...data.task,
    deadlineAt: dateUtil.formatDate(data.task.deadlineAt),
    createdAt: dateUtil.formatDate(data.task.createdAt),
    updatedAt: dateUtil.formatDate(data.task.updatedAt),
    submitFormConfig: submitForms.submitFormConfigFor(data),
  }
  const myAssignee = data.myAssignee
    ? {
        ...data.myAssignee,
        submittedAt: dateUtil.formatDate(data.myAssignee.submittedAt),
        reviewedAt: dateUtil.formatDate(data.myAssignee.reviewedAt),
        updatedAt: dateUtil.formatDate(data.myAssignee.updatedAt),
      }
    : data.myAssignee
  return {
    ...data,
    task,
    myAssignee,
    mySubmissions: Array.isArray(data.mySubmissions)
      ? data.mySubmissions.map((submission) => ({
          ...submission,
          submittedAt: dateUtil.formatDate(submission.submittedAt),
          reviewedAt: dateUtil.formatDate(submission.reviewedAt),
          createdAt: dateUtil.formatDate(submission.createdAt),
          updatedAt: dateUtil.formatDate(submission.updatedAt),
        }))
      : data.mySubmissions,
    taskItems: Array.isArray(data.taskItems)
      ? data.taskItems.map((item) => ({
          ...item,
          createdAt: dateUtil.formatDate(item.createdAt),
          updatedAt: dateUtil.formatDate(item.updatedAt),
        }))
      : data.taskItems,
    submitFormConfig: task.submitFormConfig,
    submitFormSummary: submitForms.summary(task.submitFormConfig),
  }
}

function listTasks(opts) {
  // opts: { tab, page, pageSize }
  return request({
    url: '/api/app/standard-execution/tasks/list-v2',
    method: 'GET',
    data: { ...(opts || {}), includeCounts: true },
    timeout: 12000,
    retry: 1,
    retryDelay: 1200,
    retryMaxDelay: 3000,
  }).then((res) => {
    if (res.statusCode === 200) {
      const body = res.data || {}
      return {
        ...body,
        data: Array.isArray(body.data) ? body.data.map(normalizeListTask) : [],
      }
    }
    throw new Error((res.data && res.data.error) || '加载失败')
  })
}

function getTaskDetail(taskId) {
  return request({
    url: `/api/app/standard-execution/tasks/${taskId}`,
    method: 'GET',
    timeout: 12000,
    retry: 1,
    retryDelay: 1000,
    retryMaxDelay: 3000,
  }).then((res) => {
    if (res.statusCode === 200) return normalizeDetail(res.data && res.data.data)
    if (res.statusCode === 404) throw new Error('任务不存在或已被取消')
    if (res.statusCode === 403) throw new Error('无权查看此任务')
    throw new Error((res.data && res.data.error) || '加载失败')
  })
}

function viewTask(taskId) {
  // 非阻塞触发：失败静默
  return request({
    url: `/api/app/standard-execution/tasks/${taskId}/view`,
    method: 'POST',
    data: {},
  }).catch(() => null)
}

/**
 * 提交任务
 * @param {string} taskId
 * @param {object} body { submitText, attachments: [{fileName, fileUrl, fileSize, mimeType}] }
 */
function submitTask(taskId, body) {
  return request({
    url: `/api/app/standard-execution/tasks/${taskId}/submit`,
    method: 'POST',
    data: body,
  }).then((res) => {
    if (res.statusCode === 201) return res.data && res.data.data
    throw new Error((res.data && res.data.error) || '提交失败')
  })
}

function updateTaskItem(taskId, itemId, body) {
  return request({
    url: `/api/app/standard-execution/tasks/${taskId}/items/${itemId}`,
    method: 'PATCH',
    data: body,
  }).then((res) => {
    if (res.statusCode === 200) return res.data && res.data.data
    throw new Error((res.data && res.data.error) || '要求项暂存失败')
  })
}

/**
 * 上传单个文件 — wx.uploadFile 不走 request 封装
 * @returns Promise<{fileName, fileUrl, fileSize, mimeType}>
 */
function uploadFile(taskId, tempFilePath) {
  const token = session.getToken()
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${config.API_BASE}/api/app/standard-execution/tasks/${taskId}/upload`,
      filePath: tempFilePath,
      name: 'file',
      header: token ? { Authorization: `Bearer ${token}` } : {},
      timeout: 30000,
      success: (r) => {
        let body = null
        try { body = JSON.parse(r.data || '{}') } catch (e) { /* ignore */ }
        if (r.statusCode === 200 && body && body.data) {
          resolve(body.data)
        } else {
          reject(new Error((body && body.error) || `上传失败 (${r.statusCode})`))
        }
      },
      fail: () => reject(new Error('网络错误，上传失败')),
    })
  })
}

/**
 * 获取题库题目（不含答案）
 */
function getQuiz(taskId) {
  return request({
    url: `/api/app/standard-execution/tasks/${taskId}/quiz`,
    method: 'GET',
    timeout: 12000,
    retry: 1,
    retryDelay: 1000,
    retryMaxDelay: 3000,
  }).then((res) => {
    if (res.statusCode === 200) return res.data
    throw new Error((res.data && res.data.error) || '加载失败')
  })
}

/**
 * 提交答题
 * @param {string} taskId
 * @param {{ answers: Array<{questionId:string, selected:number[]}>, timeUsedSec:number }} body
 */
function submitQuiz(taskId, body) {
  return request({
    url: `/api/app/standard-execution/tasks/${taskId}/quiz/submit`,
    method: 'POST',
    data: body,
  }).then((res) => {
    if (res.statusCode === 201 || res.statusCode === 200) return res.data
    throw new Error((res.data && res.data.error) || '提交失败')
  })
}

function listRecords(opts) {
  return request({
    url: '/api/app/standard-execution/records',
    method: 'GET',
    data: opts || { page: 1, pageSize: 20 },
    timeout: 12000,
    retry: 1,
    retryDelay: 1200,
    retryMaxDelay: 3000,
  }).then((res) => {
    if (res.statusCode === 200) {
      const body = res.data || {}
      return {
        ...body,
        data: Array.isArray(body.data)
          ? body.data.map((record) => ({
              ...record,
              recordDate: dateUtil.formatDate(record.recordDate),
              createdAt: dateUtil.formatDate(record.createdAt),
              updatedAt: dateUtil.formatDate(record.updatedAt),
            }))
          : body.data,
      }
    }
    throw new Error((res.data && res.data.error) || '加载失败')
  })
}

// ─── 草稿 ────────────────────────────────────────────

function draftKey(taskId) { return `se_draft_${taskId}` }

function loadDraft(taskId) {
  try {
    const v = wx.getStorageSync(draftKey(taskId))
    return v || null
  } catch (e) { return null }
}

function saveDraft(taskId, draft) {
  try { wx.setStorageSync(draftKey(taskId), draft) } catch (e) { /* ignore */ }
}

function clearDraft(taskId) {
  try { wx.removeStorageSync(draftKey(taskId)) } catch (e) { /* ignore */ }
}

module.exports = {
  // tabs
  TAB_KEYS,
  // labels
  TASK_STATUS_LABEL,
  ASSIGNEE_STATUS_LABEL,
  SUBMISSION_STATUS_LABEL,
  SUBMISSION_STATUS_COLOR,
  RECORD_STATUS_LABEL,
  formatDate: dateUtil.formatDate,
  submitForms,
  // api
  listTasks,
  getTaskDetail,
  viewTask,
  submitTask,
  updateTaskItem,
  uploadFile,
  getQuiz,
  submitQuiz,
  listRecords,
  // draft
  loadDraft,
  saveDraft,
  clearDraft,
}
