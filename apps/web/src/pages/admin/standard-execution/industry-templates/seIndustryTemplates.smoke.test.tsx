// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const seListIndustryTemplates = vi.fn()

vi.mock('../../../../api/standardExecution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../api/standardExecution')>()),
  seListIndustryTemplates: () => seListIndustryTemplates(),
}))

import { renderWithProviders, screen, waitFor } from '../../../../test/utils'
import SeIndustryTemplatesPage from './index'

describe('SeIndustryTemplatesPage smoke', () => {
  beforeEach(() => {
    seListIndustryTemplates.mockReset().mockResolvedValue({
      data: [{
        id: 'tpl-1',
        industryCategory: 'FOOD_SAFETY',
        title: '食品安全基础模板',
        sourceNo: 'GB-FS',
        version: '2026',
        description: null,
        status: 'PUBLISHED',
        controlPointCount: 2,
        createdBy: 'u-1',
        updatedBy: null,
        createdAt: '2026-06-17T00:00:00.000Z',
        updatedAt: '2026-06-17T00:00:00.000Z',
      }],
      total: 1,
      page: 1,
      pageSize: 20,
    })
  })

  it('renders templates from API', async () => {
    renderWithProviders(<SeIndustryTemplatesPage />, { route: '/admin/standard-execution/industry-templates' })
    await waitFor(() => expect(seListIndustryTemplates).toHaveBeenCalled())
    expect(await screen.findByText('食品安全基础模板')).toBeInTheDocument()
    expect(screen.getByText('已发布')).toBeInTheDocument()
  })
})
