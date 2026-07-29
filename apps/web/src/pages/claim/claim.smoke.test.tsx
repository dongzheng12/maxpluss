// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nodeApiGet = vi.fn()
vi.mock('../../api/client', () => ({ nodeApi: { get: (...a: unknown[]) => nodeApiGet(...a), post: vi.fn() } }))
vi.mock('../../api/app', () => ({ getCaptcha: vi.fn().mockResolvedValue({ token: 't', svg: '' }), sendVerifyCode: vi.fn() }))
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useParams: () => ({ code: 'GIFT123' }) }
})

import { renderWithProviders, waitFor } from '../../test/utils'
import ClaimPage from './index'

describe('ClaimPage smoke', () => {
  beforeEach(() => { nodeApiGet.mockReset().mockResolvedValue({ gift: { name: '会员体验' } }) })
  it('fetches the gift info by claim code', async () => {
    renderWithProviders(<ClaimPage />, { route: '/claim/GIFT123' })
    await waitFor(() => expect(nodeApiGet).toHaveBeenCalled())
  })
})
