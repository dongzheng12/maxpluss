// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listCompareTasks = vi.fn()
const getQueueStatus = vi.fn()
vi.mock('../../api/app', () => ({
  createCompareTask: vi.fn(),
  listCompareTasks: () => listCompareTasks(),
  libraryCompare: vi.fn(),
  recognizeFile: vi.fn(),
  recognizeAndCompare: vi.fn(),
  deleteCompareTask: vi.fn(),
  retryCompareTask: vi.fn(),
  getQueueStatus: () => getQueueStatus(),
}))

let access = {
  checkAndConsume: () => true,
  getCompareReportAccess: () => ({ allowed: true }),
  isPro: true,
  isPaid: true,
  isLoggedIn: true,
  requireLogin: () => true,
}
vi.mock('../../hooks/useAccess', () => ({ useAccess: () => access }))

import { renderWithProviders, screen, userEvent } from '../../test/utils'
import ComparePage from './index'

describe('ComparePage smoke', () => {
  beforeEach(() => {
    access = {
      checkAndConsume: () => true,
      getCompareReportAccess: () => ({ allowed: true }),
      isPro: true,
      isPaid: true,
      isLoggedIn: true,
      requireLogin: () => true,
    }
    listCompareTasks.mockReset().mockResolvedValue({ items: [] })
    getQueueStatus.mockReset().mockResolvedValue({ pending: 0 })
  })

  it('opens the launch panel and shows the comparison-mode options', async () => {
    renderWithProviders(<ComparePage />)
    await userEvent.click(await screen.findByRole('button', { name: /发起比对/ }))
    // Mode selector exposes the full-library and pairwise options.
    expect(await screen.findByText('全库相似度分析')).toBeInTheDocument()
    expect(screen.getByText('1 对 1 精准比对')).toBeInTheDocument()
  })

  it('prompts the guest to log in', async () => {
    access = { ...access, isLoggedIn: false }
    renderWithProviders(<ComparePage />)
    expect(await screen.findByRole('button', { name: /去登录/ })).toBeInTheDocument()
  })
})
