// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const seListReviewsEnterprise = vi.fn()
const seGetReviewEnterprise = vi.fn()
const seAnalyzeReviewEnterprise = vi.fn()
const seListEnterpriseMembers = vi.fn()
const seRejectReviewEnterprise = vi.fn()
const seApproveReviewEnterprise = vi.fn()

vi.mock('../../../../api/standardExecution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../api/standardExecution')>()),
  seListReviewsEnterprise: (params: Record<string, unknown>) => seListReviewsEnterprise(params),
  seGetReviewEnterprise: (id: string) => seGetReviewEnterprise(id),
  seAnalyzeReviewEnterprise: (id: string) => seAnalyzeReviewEnterprise(id),
  seListEnterpriseMembers: () => seListEnterpriseMembers(),
  seRejectReviewEnterprise: (id: string, body: Record<string, unknown>) => seRejectReviewEnterprise(id, body),
  seApproveReviewEnterprise: (id: string, body: Record<string, unknown>) => seApproveReviewEnterprise(id, body),
}))

import { renderWithProviders, screen, userEvent, waitFor } from '../../../../test/utils'
import SeReviewsPage from './index'

const reviewRow = {
  submission: {
    id: 'sub-1',
    version: 1,
    isLatest: true,
    submitText: '今日温控已处理。',
    status: 'SUBMITTED',
    submittedAt: '2026-06-17T00:00:00.000Z',
    reviewedAt: null,
    reviewComment: null,
  },
  task: { id: 'task-1', title: '每日温控检查', deadlineAt: '2026-06-18T00:00:00.000Z', reviewerId: 'reviewer-1' },
  requirement: { id: 'req-1', title: '仓储温控记录' },
  assigneeId: 'user-1',
  assignee: { status: 'PENDING_REVIEW', submittedAt: '2026-06-17T00:00:00.000Z', reviewedAt: null },
}

const detail = {
  submission: {
    id: 'sub-1',
    version: 1,
    isLatest: true,
    submitText: '今日温控已处理。',
    status: 'SUBMITTED',
    submittedAt: '2026-06-17T00:00:00.000Z',
    reviewedAt: null,
    reviewerId: null,
    reviewComment: null,
    assigneeId: 'user-1',
    taskId: 'task-1',
  },
  attachments: [],
  task: {
    id: 'task-1',
    title: '每日温控检查',
    description: null,
    deadlineAt: '2026-06-18T00:00:00.000Z',
    reviewerId: 'reviewer-1',
    taskType: 'INSPECTION_FILL',
    checklistSchema: null,
    parametersSchema: null,
  },
  requirement: {
    id: 'req-1',
    title: '仓储温控记录',
    requirementText: '每日留存仓储温控记录和现场照片。',
    requiredMaterials: ['温控记录表', '现场照片'],
    source: { id: 'source-1', title: '仓储温控规范' },
  },
  assignee: { id: 'ta-1', assigneeId: 'user-1', status: 'PENDING_REVIEW' },
  reviewLogs: [],
  canApprove: true,
}

const aiAnalysis = {
  recommendation: 'REJECT',
  confidence: 0.78,
  summary: '提交内容未能充分覆盖当前控制点要求，建议驳回补充。',
  reasons: ['缺少或未明确体现材料：温控记录表、现场照片'],
  checks: {
    completeness: { status: 'FAIL', missingMaterials: ['温控记录表', '现场照片'], note: '提交内容未覆盖全部材料要求。' },
    fillQuality: { status: 'NA', note: '非结构化填报任务。' },
    anomaly: { status: 'NA', note: '无历史同类提交。' },
  },
  suggestedComment: '建议补充后重新提交：缺少温控记录表、现场照片。仅供参考，最终以人工审核为准',
  disclaimer: '仅供参考，最终以人工审核为准',
}

describe('SeReviewsPage AI smoke', () => {
  beforeEach(() => {
    localStorage.removeItem('se_review_ai_auto')
    seListEnterpriseMembers.mockReset().mockResolvedValue({ data: [] })
    seListReviewsEnterprise.mockReset().mockResolvedValue({ data: [reviewRow], total: 1, page: 1, pageSize: 20 })
    seGetReviewEnterprise.mockReset().mockResolvedValue({ data: detail })
    seAnalyzeReviewEnterprise.mockReset().mockResolvedValue({ data: aiAnalysis })
    seRejectReviewEnterprise.mockReset().mockResolvedValue({ data: {} })
    seApproveReviewEnterprise.mockReset().mockResolvedValue({ data: {} })
  })

  it('loads AI analysis and applies suggested reject comment', async () => {
    renderWithProviders(<SeReviewsPage />, { route: '/enterprise/reviews' })

    await userEvent.click(await screen.findByText('每日温控检查'))
    await waitFor(() => expect(seAnalyzeReviewEnterprise).toHaveBeenCalledWith('sub-1'))
    expect(await screen.findByText('AI 合规顾问')).toBeInTheDocument()
    expect(screen.getByText('建议驳回')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '采用建议' }))
    await waitFor(() => expect(screen.getAllByDisplayValue(/建议补充后重新提交/).length).toBeGreaterThanOrEqual(1))
  })
})
