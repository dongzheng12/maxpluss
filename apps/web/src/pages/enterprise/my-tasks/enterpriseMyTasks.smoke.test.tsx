// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  nodeApiGet: vi.fn(),
  nodeApiPost: vi.fn(),
  nodeApiPatch: vi.fn(),
}))

const seListMyTasksV2 = vi.fn()
vi.mock('../../../api/standardExecution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/standardExecution')>()),
  seListMyTasksV2: (...a: unknown[]) => seListMyTasksV2(...a),
  seGetTaskItems: () => Promise.resolve({ data: [] }),
  sePatchTaskItem: vi.fn(),
}))
vi.mock('../../../api/client', () => ({
  nodeApi: { get: apiMocks.nodeApiGet, post: apiMocks.nodeApiPost, patch: apiMocks.nodeApiPatch },
}))

import { renderWithProviders, screen, userEvent, waitFor } from '../../../test/utils'
import MyTasksPage from './index'

describe('EnterpriseMyTasksPage smoke', () => {
  beforeEach(() => {
    seListMyTasksV2.mockReset().mockResolvedValue({ data: [], counts: {}, total: 0 })
    apiMocks.nodeApiGet.mockReset()
    apiMocks.nodeApiPost.mockReset().mockResolvedValue({})
    apiMocks.nodeApiPatch.mockReset()
  })
  it('loads the employee task list', async () => {
    renderWithProviders(<MyTasksPage />, { route: '/enterprise/my-tasks' })
    await waitFor(() => expect(seListMyTasksV2).toHaveBeenCalled())
  })

  it('shows miniapp-only prompt for training quiz tasks', async () => {
    seListMyTasksV2.mockResolvedValueOnce({
      data: [{
        assigneeId: 'assignee-1',
        assigneeUserId: 'employee-1',
        assigneeStatus: 'IN_PROGRESS',
        submittedAt: null,
        reviewedAt: null,
        isRejected: false,
        isOverdue: false,
        availableActions: ['SUBMIT'],
        task: {
          id: 'task-training',
          title: '培训题库任务',
          description: null,
          taskType: 'TRAINING',
          status: 'PUBLISHED',
          deadlineAt: '2026-06-20T00:00:00.000Z',
          submitRequirement: '完成培训题库',
          basis: [],
          source: null,
          requirement: { id: 'req-1', title: '条款', clauseNo: null, source: { id: 'src-1', title: '标准' } },
          taskItems: [],
          hasTaskItems: false,
          hasQuiz: true,
          quizBankId: 'quiz-1',
          reviewer: null,
          assigneeSummary: { total: 1, pending: 0, inProgress: 1, pendingReview: 0, completed: 0, rejected: 0, overdue: 0 },
        },
      }],
      counts: { todo: 1, review: 0, done: 0, closed: 0 },
      total: 1,
    })
    apiMocks.nodeApiGet.mockResolvedValueOnce({
      data: {
        task: {
          id: 'task-training',
          title: '培训题库任务',
          description: null,
          submitRequirement: '完成培训题库',
          deadlineAt: '2026-06-20T00:00:00.000Z',
          status: 'PUBLISHED',
          reviewerId: 'reviewer-1',
          taskType: 'TRAINING',
          checklistSchema: null,
          parametersSchema: null,
          learningMaterials: { items: [] },
          quizBankId: 'quiz-1',
        },
        requirement: { id: 'req-1', title: '条款', clauseNo: null, source: { id: 'src-1', title: '标准' } },
        myAssignee: { id: 'assignee-1', status: 'IN_PROGRESS', submittedAt: null, reviewedAt: null },
        mySubmissions: [],
        isOverdue: false,
      },
    })

    renderWithProviders(<MyTasksPage />, { route: '/enterprise/my-tasks' })
    await waitFor(() => expect(screen.getAllByText('培训题库任务').length).toBeGreaterThan(0))
    await userEvent.click(screen.getAllByRole('button', { name: '查看/提交' })[0])
    await screen.findByRole('button', { name: '提交任务' })
    await userEvent.click(screen.getByRole('button', { name: '提交任务' }))

    expect(await screen.findByText('请在小程序完成答题')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '小程序完成答题' })).toBeDisabled()
  })
})
