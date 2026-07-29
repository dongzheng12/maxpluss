// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nodeApiGet = vi.fn()
vi.mock('../../api/client', () => ({ nodeApi: { get: (...a: unknown[]) => nodeApiGet(...a) } }))

import { renderWithProviders, screen, waitFor } from '../../test/utils'
import SalesMaterialPage from './index'

describe('SalesMaterialPage smoke', () => {
  beforeEach(() => { nodeApiGet.mockReset().mockResolvedValue({ wechatGroup: '群发文案', moments: '朋友圈文案', intro: '个人介绍' }) })
  it('renders the promotion-material page and loads materials', async () => {
    renderWithProviders(<SalesMaterialPage />)
    await waitFor(() => expect(nodeApiGet).toHaveBeenCalledWith('/api/app/sales/materials'))
    expect(await screen.findByText('推广素材')).toBeInTheDocument()
  })
})
