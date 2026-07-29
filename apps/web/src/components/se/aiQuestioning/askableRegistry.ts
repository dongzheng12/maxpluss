import type { AIQuestionContext } from './types'

export interface RegisteredAIAskable {
  context: AIQuestionContext
  question?: string
}

const registry = new Map<string, RegisteredAIAskable>()

export function registerAIAskable(id: string, entry: RegisteredAIAskable) {
  registry.set(id, entry)
  return () => {
    registry.delete(id)
  }
}

export function getAIAskable(id: string | null | undefined) {
  return id ? registry.get(id) || null : null
}

export function clearAIAskableRegistryForTest() {
  registry.clear()
}

export function findAIAskableFromTarget(target: EventTarget | null): RegisteredAIAskable | null {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return null
  const host = target.closest<HTMLElement>('[data-ai-askable-id]')
  return getAIAskable(host?.dataset.aiAskableId)
}
