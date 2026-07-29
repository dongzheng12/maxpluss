// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nodeApiGet = vi.fn()
vi.mock('../../../api/client', () => ({ nodeApi: { get: (...a: unknown[]) => nodeApiGet(...a) } }))

import { renderWithProviders, screen, waitFor } from '../../../test/utils'
import AdminCompareTasksPage from './index'

describe('AdminCompareTasksPage smoke', () => {
  beforeEach(() => { nodeApiGet.mockReset().mockResolvedValue({ items: [] }) })
  it('renders the compare-task management page and loads tasks', async () => {
    renderWithProviders(<AdminCompareTasksPage />)
    expect(screen.getByText('比对任务管理')).toBeInTheDocument()
    await waitFor(() => expect(nodeApiGet).toHaveBeenCalledWith('/api/admin/compare-tasks'))
  })
})
