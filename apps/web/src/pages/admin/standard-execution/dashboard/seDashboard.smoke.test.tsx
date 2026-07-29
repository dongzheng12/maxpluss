// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const seGetDashboardEnterprise = vi.fn()
vi.mock('../../../../api/standardExecution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../api/standardExecution')>()),
  seGetDashboardEnterprise: () => seGetDashboardEnterprise(),
}))

import { renderWithProviders, screen, waitFor } from '../../../../test/utils'
import SeDashboardPage from './index'

describe('SeDashboardPage (enterprise) smoke', () => {
  beforeEach(() => {
    seGetDashboardEnterprise.mockReset().mockResolvedValue({ counts: {}, recentRecords: [], recentTasks: [] })
  })

  it('loads the enterprise dashboard data under the enterprise route', async () => {
    renderWithProviders(<SeDashboardPage />, { route: '/enterprise/dashboard' })
    await waitFor(() => expect(seGetDashboardEnterprise).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: /刷新/ })).toBeInTheDocument()
  })
})
