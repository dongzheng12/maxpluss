// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const seListRisksEnterprise = vi.fn()
const seGetDashboardEnterprise = vi.fn()
vi.mock('../../../../api/standardExecution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../api/standardExecution')>()),
  seListRisksEnterprise: () => seListRisksEnterprise(),
  seGetDashboardEnterprise: () => seGetDashboardEnterprise(),
}))

import { renderWithProviders, waitFor } from '../../../../test/utils'
import SeRisksPage from './index'

describe('SeRisksPage (enterprise) smoke', () => {
  beforeEach(() => {
    seListRisksEnterprise.mockReset().mockResolvedValue({ items: [] })
    seGetDashboardEnterprise.mockReset().mockResolvedValue({
      data: {
        complianceRadar: {
          generatedAt: '2026-06-17T00:00:00.000Z',
          metrics: {
            controlPointCoverage: { covered: 0, total: 0, rate: 0 },
            monthlyTaskCompletion: { completed: 0, total: 0, rate: 0 },
            reviewPassRate: { approved: 0, total: 0, rate: 0 },
            overdueTasks: { count: 0 },
          },
          heatmap: [],
          expiringRecords: [],
          riskEvents: [],
        },
      },
    })
  })

  it('loads enterprise risks under the enterprise route', async () => {
    renderWithProviders(<SeRisksPage />, { route: '/enterprise/risks' })
    await waitFor(() => expect(seGetDashboardEnterprise).toHaveBeenCalled())
    await waitFor(() => expect(seListRisksEnterprise).toHaveBeenCalled())
  })
})
