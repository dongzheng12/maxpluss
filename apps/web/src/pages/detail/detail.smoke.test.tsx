// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getStandardDetail = vi.fn()
const getStandardRelations = vi.fn()
vi.mock('../../api/standards', () => ({
  getStandardDetail: (...a: unknown[]) => getStandardDetail(...a),
  getStandardRelations: (...a: unknown[]) => getStandardRelations(...a),
}))

import { renderWithProviders, screen, userEvent, waitFor } from '../../test/utils'
import DetailPage from './index'

const stdDetail = { code: 'GB/T 1.1-2020', name: '标准化工作导则', status: '现行', source: '国家标准', is_mandatory: false }

function renderDetail(code = 'GB/T 1.1-2020') {
  return renderWithProviders(
    <DetailPage />,
    { route: [`/standards/${encodeURIComponent(code)}`] },
  )
}

// DetailPage reads :code via useParams, so mount it under a matching route.
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useParams: () => ({ code: 'GB/T 1.1-2020' }) }
})

describe('DetailPage smoke', () => {
  beforeEach(() => {
    getStandardDetail.mockReset().mockResolvedValue(stdDetail)
    getStandardRelations.mockReset().mockResolvedValue({ relations: {} })
  })

  it('renders the standard header after loading', async () => {
    renderDetail()
    await waitFor(() => expect(getStandardDetail).toHaveBeenCalledWith('GB/T 1.1-2020'))
    expect(await screen.findByText('标准化工作导则')).toBeInTheDocument()
    expect(screen.getByText('现行')).toBeInTheDocument()
  })

  it('toggles favorite state and persists it to localStorage', async () => {
    renderDetail()
    const favBtn = await screen.findByRole('button', { name: /收藏/ })
    await userEvent.click(favBtn)
    expect(await screen.findByRole('button', { name: /已收藏/ })).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('bxz_favorites') || '[]')).toContain('GB/T 1.1-2020')
  })

  it('shows a not-found card when the standard is missing', async () => {
    getStandardDetail.mockResolvedValue(null)
    renderDetail()
    expect(await screen.findByText(/未找到标准/)).toBeInTheDocument()
  })
})
