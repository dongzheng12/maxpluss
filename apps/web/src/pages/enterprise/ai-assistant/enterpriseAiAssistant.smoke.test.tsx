// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const chatState = {
  conversations: [], currentConvId: null, messages: [], isStreaming: false,
  isLoadingHistory: false, remainingQuota: 5, quotaTier: 'enterprise',
  loadConversations: vi.fn(), switchConversation: vi.fn(), createNewConversation: vi.fn(),
  sendMessage: vi.fn(), confirmOutline: vi.fn(), deleteConversation: vi.fn(), renameConversation: vi.fn(),
}
vi.mock('../../chat/useChat', () => ({ useChat: () => chatState }))
vi.mock('../../../contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../contexts/AuthContext')>()),
  useAuth: () => ({ user: { id: '1' }, isLoggedIn: true, login: vi.fn(), logout: vi.fn() }),
}))

import { renderWithProviders, screen } from '../../../test/utils'
import EnterpriseAiAssistantPage from './index'

describe('EnterpriseAiAssistantPage smoke', () => {
  beforeEach(() => { chatState.conversations = []; chatState.messages = [] })
  it('renders the enterprise assistant chat input', () => {
    renderWithProviders(<EnterpriseAiAssistantPage />, { route: '/enterprise/ai-assistant' })
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })
})
