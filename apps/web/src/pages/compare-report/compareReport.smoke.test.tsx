// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getCompareTask = vi.fn()
const unlockCompareReport = vi.fn()
vi.mock('../../api/app', () => ({
  getCompareTask: (...a: unknown[]) => getCompareTask(...a),
  unlockCompareReport: (...a: unknown[]) => unlockCompareReport(...a),
  retryCompareTask: vi.fn(),
}))
vi.mock('../../hooks/useAccess', () => ({ useAccess: () => ({ isPaid: true }) }))
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useParams: () => ({ taskNo: 'CMP-1' }) }
})

import { renderWithProviders, screen, waitFor } from '../../test/utils'
import CompareReportPage from './index'

describe('CompareReportPage smoke', () => {
  beforeEach(() => {
    getCompareTask.mockReset()
    unlockCompareReport.mockReset()
  })

  it('renders a completed library report header with the PDF export when unlocked', async () => {
    getCompareTask.mockResolvedValue({
      status: 'COMPLETED',
      compareMode: 'library',
      documentName: '产品标准.docx',
      access: { fullReportUnlocked: true },
      report: { items: [] },
      freeRisk: [],
    })
    renderWithProviders(<CompareReportPage />)
    await waitFor(() => expect(getCompareTask).toHaveBeenCalledWith('CMP-1'))
    expect(await screen.findByText('全库相似度分析')).toBeInTheDocument()
    expect(screen.getByText('已完成')).toBeInTheDocument()
    expect(screen.getByText(/导出 PDF/)).toBeInTheDocument()
  })

  it('shows an empty state when the report does not exist', async () => {
    getCompareTask.mockResolvedValue(null)
    renderWithProviders(<CompareReportPage />)
    expect(await screen.findByText('报告不存在或已失效')).toBeInTheDocument()
  })
})
