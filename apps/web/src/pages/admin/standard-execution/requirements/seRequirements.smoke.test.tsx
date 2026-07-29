// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const seListRequirementsEnterprise = vi.fn()
const seListSourcesEnterprise = vi.fn()
const seListEnterpriseMembers = vi.fn()

vi.mock('../../../../api/standardExecution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../api/standardExecution')>()),
  seListRequirementsEnterprise: () => seListRequirementsEnterprise(),
  seListSourcesEnterprise: () => seListSourcesEnterprise(),
  seListEnterpriseMembers: () => seListEnterpriseMembers(),
}))

import { renderWithProviders, screen, waitFor } from '../../../../test/utils'
import SeRequirementsPage from './index'

describe('SeRequirementsPage (enterprise) smoke', () => {
  beforeEach(() => {
    seListSourcesEnterprise.mockReset().mockResolvedValue({
      data: [{ id: 'src-1', title: '测试标准', status: 'ACTIVE', rawText: 'raw' }],
    })
    seListEnterpriseMembers.mockReset().mockResolvedValue({ data: [] })
    seListRequirementsEnterprise.mockReset().mockResolvedValue({
      data: [{
        id: 'req-1',
        enterpriseId: 'ent-1',
        sourceId: 'src-1',
        clauseNo: '5.1',
        title: '温控记录',
        requirementText: '每日记录温控',
        applicableDeptIds: null,
        archiveTags: null,
        generateMode: 'MANUAL',
        status: 'ACTIVE',
        createdBy: 'u-1',
        updatedBy: null,
        createdAt: '2026-06-17T00:00:00.000Z',
        updatedAt: '2026-06-17T00:00:00.000Z',
        taskCount: 1,
        latestTaskStatus: 'COMPLETED',
        health: {
          status: 'EXPIRING',
          taskCount: 1,
          validRecordCount: 1,
          latestValidRecordDate: '2026-06-10T00:00:00.000Z',
          validUntil: '2026-06-22T00:00:00.000Z',
          daysUntilExpiry: 5,
          description: '最近有效证据将在 5 天内到期，建议提前更新。',
        },
      }],
      total: 1,
      page: 1,
      pageSize: 20,
    })
  })

  it('renders requirement health status from enterprise list API', async () => {
    renderWithProviders(<SeRequirementsPage />, { route: '/enterprise/requirements' })
    await waitFor(() => expect(seListRequirementsEnterprise).toHaveBeenCalled())
    expect(await screen.findByText('温控记录')).toBeInTheDocument()
    expect(screen.getByText('即将到期')).toBeInTheDocument()
  })
})
