// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getReferralCode = vi.fn()
vi.mock('../../api/app', () => ({ getReferralCode: () => getReferralCode() }))
vi.mock('../../contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/AuthContext')>()),
  useAuth: () => ({ user: { id: '1' }, isLoggedIn: true, login: vi.fn(), logout: vi.fn() }),
}))

import { renderWithProviders, waitFor } from '../../test/utils'
import ReferralPage from './index'

describe('ReferralPage smoke', () => {
  beforeEach(() => { getReferralCode.mockReset().mockResolvedValue({ code: 'ABCD2345', inviteCount: 0 }) })
  it('loads the referral code for a logged-in user', async () => {
    renderWithProviders(<ReferralPage />, { route: '/referral' })
    await waitFor(() => expect(getReferralCode).toHaveBeenCalled())
  })
})
