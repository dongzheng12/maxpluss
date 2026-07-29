// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getHomeData = vi.fn()
vi.mock('../../api/app', () => ({ getHomeData: () => getHomeData() }))

import { renderWithProviders, screen, userEvent, waitFor } from '../../test/utils'
import HomePage from './index'

describe('HomePage smoke', () => {
  beforeEach(() => {
    getHomeData.mockReset().mockResolvedValue({
      heroStats: { standardCount: 100 },
      announcements: [{ id: 'a1', title: '系统升级公告', date: '2026-06-01', content: '升级说明正文' }],
    })
  })

  it('renders the hero search and the core tool entries', async () => {
    renderWithProviders(<HomePage />)
    await waitFor(() => expect(getHomeData).toHaveBeenCalled())
    expect(screen.getByPlaceholderText('请输入标准号、关键词或问题')).toBeInTheDocument()
    expect(screen.getByText('标准信息查询')).toBeInTheDocument()
    expect(screen.getByText('文档比对')).toBeInTheDocument()
  })

  it('opens the announcement detail modal on click', async () => {
    renderWithProviders(<HomePage />)
    const ann = await screen.findByText('系统升级公告')
    await userEvent.click(ann)
    expect(await screen.findByText('升级说明正文')).toBeInTheDocument()
  })
})
