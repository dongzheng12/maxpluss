// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const seListPlans = vi.fn()
vi.mock('../../../../api/standardExecution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../api/standardExecution')>()),
  enterpriseMe: () => Promise.resolve({ enterpriseRole: 'ADMIN', isAdminBypass: false }),
  seListPlans: (...a: unknown[]) => seListPlans(...a),
  seListSourcesEnterprise: () => Promise.resolve({ items: [] }),
  seListTasksEnterprise: () => Promise.resolve({ items: [] }),
  seListRequirementsEnterprise: () => Promise.resolve({ items: [] }),
  seListEnterpriseMembers: () => Promise.resolve({ items: [] }),
  seListComplianceCycleTemplates: () => Promise.resolve({ data: [], total: 0, page: 1, pageSize: 100 }),
  seListComplianceCycles: () => Promise.resolve({ data: [], total: 0, page: 1, pageSize: 100 }),
}))

import { renderWithProviders, waitFor } from '../../../../test/utils'
import SePlansPage from './index'

describe('SePlansPage (enterprise) smoke', () => {
  beforeEach(() => {
    seListPlans.mockReset().mockResolvedValue({ items: [], total: 0 })
  })

  it('loads execution plans under the enterprise route', async () => {
    renderWithProviders(<SePlansPage />, { route: '/enterprise/plans' })
    await waitFor(() => expect(seListPlans).toHaveBeenCalled())
  })
})
