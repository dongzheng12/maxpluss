// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const seGetIntelligenceDashboardEnterprise = vi.fn()
const seExportIntelligenceDashboardEnterprise = vi.fn()

vi.mock('../../../../api/standardExecution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../api/standardExecution')>()),
  seGetIntelligenceDashboardEnterprise: (range: number) => seGetIntelligenceDashboardEnterprise(range),
  seExportIntelligenceDashboardEnterprise: (range: number) => seExportIntelligenceDashboardEnterprise(range),
}))

import { renderWithProviders, screen, waitFor } from '../../../../test/utils'
import SeIntelligenceDashboardPage from './index'

const mockData = {
  generatedAt: '2026-06-17T00:00:00.000Z',
  rangeDays: 90,
  range: { startDate: '2026-03-20', endDate: '2026-06-17' },
  overview: {
    totalRequirements: 2,
    coveredRequirements: 1,
    uncoveredRequirements: 1,
    coverageRate: 50,
    tasksTotal: 2,
    tasksCompleted: 1,
    taskCompletionRate: 50,
    reviewsTotal: 2,
    reviewsApproved: 1,
    reviewPassRate: 50,
    overdueTasks: 1,
  },
  trends: {
    taskCompletion: [{ label: '06-11~06-17', startDate: '2026-06-11', endDate: '2026-06-17', total: 2, completed: 1, rate: 50 }],
    reviewPass: [{ label: '06-11~06-17', startDate: '2026-06-11', endDate: '2026-06-17', total: 2, approved: 1, rate: 50 }],
    overdue: [{ label: '06-11~06-17', startDate: '2026-06-11', endDate: '2026-06-17', total: 1, overdue: 1 }],
  },
  department: {
    visible: true,
    rows: [{ departmentId: 'QA', controlPointCount: 2, coveredCount: 1, coverageRate: 50, overdueTaskCount: 1 }],
  },
  people: {
    visible: true,
    topExecutors: [{ userId: 'u1', name: '执行人', totalTasks: 2, completedTasks: 1, completionRate: 50 }],
    bottomExecutors: [{ userId: 'u1', name: '执行人', totalTasks: 2, completedTasks: 1, completionRate: 50 }],
    reviewEfficiency: [{ userId: 'u2', name: '审核人', reviewedCount: 2, approvedCount: 1, passRate: 50, avgReviewHours: 1.5 }],
  },
}

describe('SeIntelligenceDashboardPage smoke', () => {
  beforeEach(() => {
    seGetIntelligenceDashboardEnterprise.mockReset().mockResolvedValue({ data: mockData })
    seExportIntelligenceDashboardEnterprise.mockReset().mockResolvedValue(new Blob(['xlsx']))
  })

  it('loads enterprise intelligence dashboard data', async () => {
    renderWithProviders(<SeIntelligenceDashboardPage />, { route: '/enterprise/intelligence-dashboard' })

    await waitFor(() => expect(seGetIntelligenceDashboardEnterprise).toHaveBeenCalledWith(90))
    expect(await screen.findByText('控制点覆盖率')).toBeInTheDocument()
    expect(screen.getByText('部门覆盖率排行')).toBeInTheDocument()
    expect(screen.getAllByText('执行人').length).toBeGreaterThan(0)
  })
})
