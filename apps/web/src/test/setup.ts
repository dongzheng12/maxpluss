import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// Unmount React trees between tests so portals (Modal/Drawer) don't leak.
// Guarded so the default node-environment contract tests (no document) skip it.
afterEach(() => {
  if (typeof document !== 'undefined') cleanup()
  if (typeof window !== 'undefined') {
    window.localStorage?.clear()
    window.sessionStorage?.clear()
  }
})

// antd relies on browser APIs that jsdom does not implement. Polyfill the
// minimal surface so components like Modal / Drawer / Select / Table render
// without throwing during smoke tests.
if (typeof window !== 'undefined') {
  // Node 24 ships an experimental global `localStorage` that shadows jsdom's
  // window.localStorage and throws unless `--localstorage-file` is set. Pages
  // read the bare global `localStorage`, so install a real in-memory Storage on
  // both window and globalThis to make it functional and isolated per run.
  class MemoryStorage implements Storage {
    private store = new Map<string, string>()
    get length() {
      return this.store.size
    }
    clear() {
      this.store.clear()
    }
    getItem(key: string) {
      return this.store.has(key) ? this.store.get(key)! : null
    }
    key(index: number) {
      return Array.from(this.store.keys())[index] ?? null
    }
    removeItem(key: string) {
      this.store.delete(key)
    }
    setItem(key: string, value: string) {
      this.store.set(key, String(value))
    }
  }
  const localStorageImpl = new MemoryStorage()
  const sessionStorageImpl = new MemoryStorage()
  Object.defineProperty(window, 'localStorage', { value: localStorageImpl, configurable: true })
  Object.defineProperty(window, 'sessionStorage', { value: sessionStorageImpl, configurable: true })
  Object.defineProperty(globalThis, 'localStorage', { value: localStorageImpl, configurable: true })
  Object.defineProperty(globalThis, 'sessionStorage', { value: sessionStorageImpl, configurable: true })

  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList
  }

  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  }

  window.scrollTo = (() => {}) as typeof window.scrollTo

  if (!('IntersectionObserver' in window)) {
    ;(window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
      readonly root = null
      readonly rootMargin = ''
      readonly thresholds = []
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return []
      }
    }
  }

  const jsdomGetComputedStyle = window.getComputedStyle?.bind(window)
  window.getComputedStyle = ((elt: Element, pseudoElt?: string | null) => {
    if (pseudoElt) {
      return { getPropertyValue: () => '' } as unknown as CSSStyleDeclaration
    }
    try {
      return jsdomGetComputedStyle?.(elt) ?? ({ getPropertyValue: () => '' } as unknown as CSSStyleDeclaration)
    } catch {
      return { getPropertyValue: () => '' } as unknown as CSSStyleDeclaration
    }
  }) as typeof window.getComputedStyle
}

// matchMedia is sometimes read off globalThis directly by libraries.
if (typeof globalThis.matchMedia === 'undefined' && typeof window !== 'undefined') {
  globalThis.matchMedia = window.matchMedia
}

// Silence the noisy antd v6 "React 19" compatibility warning in test output.
const originalError = console.error
vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
  const first = args[0]
  if (typeof first === 'string' && first.includes('[antd: compatible]')) return
  originalError(...args)
})
