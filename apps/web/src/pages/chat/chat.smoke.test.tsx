// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const chatState = {
  conversations: [] as unknown[],
  currentConvId: null as string | null,
  messages: [] as unknown[],
  isStreaming: false,
  isLoadingHistory: false,
  remainingQuota: 5,
  quotaTier: 'free',
  loadConversations: vi.fn(),
  switchConversation: vi.fn(),
  createNewConversation: vi.fn(),
  sendMessage: vi.fn(),
  confirmOutline: vi.fn(),
  deleteConversation: vi.fn(),
  renameConversation: vi.fn(),
}
vi.mock('./useChat', () => ({ useChat: () => chatState }))

let mockAuth: { user: { id: string } | null; isLoggedIn: boolean; login: () => void; logout: () => void } = { user: { id: '1' }, isLoggedIn: true, login: vi.fn(), logout: vi.fn() }
vi.mock('../../contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/AuthContext')>()),
  useAuth: () => mockAuth,
}))

import { renderWithProviders, screen } from '../../test/utils'
import ChatPage from './index'

describe('ChatPage smoke', () => {
  beforeEach(() => {
    mockAuth = { user: { id: '1' }, isLoggedIn: true, login: vi.fn(), logout: vi.fn() }
    chatState.conversations = []
    chatState.messages = []
  })

  it('renders the chat input for a logged-in user', () => {
    renderWithProviders(<ChatPage />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('gates the input with a login prompt when signed out', () => {
    mockAuth = { user: null, isLoggedIn: false, login: vi.fn(), logout: vi.fn() }
    renderWithProviders(<ChatPage />)
    expect(screen.getByPlaceholderText('请先登录后使用')).toBeInTheDocument()
  })
})
