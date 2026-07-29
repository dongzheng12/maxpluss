// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const seGetComplianceMatrixEnterprise = vi.fn()

vi.mock('../../../api/standardExecution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/standardExecution')>()),
  seGetComplianceMatrixEnterprise: (params: Record<string, unknown>) => seGetComplianceMatrixEnterprise(params),
}))

import { renderWithProviders, screen, waitFor } from '../../../test/utils'
import EnterpriseComplianceMatrixPage from './index'

describe('EnterpriseComplianceMatrixPage smoke', () => {
  beforeEach(() => {
    seGetComplianceMatrixEnterprise.mockReset().mockResolvedValue({
      data: {
        sources: [
          { id: 'source-a', title: '食品安全标准', sourceNo: 'GB-FOOD', version: '2026' },
          { id: 'source-b', title: '内控检查表', sourceNo: 'IC-CHECK', version: '1.0' },
        ],
        rows: [
          {
            id: 'req-a',
            sourceId: 'source-a',
            clauseNo: '4.1',
            title: '温控留痕',
            requirementText: '每日留存温控记录。',
            source: { id: 'source-a', title: '食品安全标准', sourceNo: 'GB-FOOD', version: '2026' },
            coverageBySource: { 'source-a': { status: 'DIRECT', recordIds: ['record-a'] } },
          },
          {
            id: 'req-b',
            sourceId: 'source-b',
            clauseNo: 'A.2',
            title: '仓储温控',
            requirementText: '仓储过程需证明温控有效。',
            source: { id: 'source-b', title: '内控检查表', sourceNo: 'IC-CHECK', version: '1.0' },
            coverageBySource: { 'source-a': { status: 'REUSED', recordIds: ['record-a'] } },
          },
        ],
      },
      total: 205,
      page: 1,
      pageSize: 50,
    })
  })

  it('loads paged matrix rows and renders coverage states', async () => {
    renderWithProviders(<EnterpriseComplianceMatrixPage />, { route: '/enterprise/compliance-matrix' })

    await waitFor(() => expect(seGetComplianceMatrixEnterprise).toHaveBeenCalledWith({
      page: 1,
      pageSize: 50,
      sourceId: undefined,
    }))
    expect(await screen.findByText('温控留痕')).toBeInTheDocument()
    expect(screen.getByText('仓储温控')).toBeInTheDocument()
    expect(screen.getByText('已覆盖')).toBeInTheDocument()
    expect(screen.getByText('复用')).toBeInTheDocument()
    expect(screen.getByText('控制点超过 200 条，矩阵已按页加载。')).toBeInTheDocument()
  })
})
