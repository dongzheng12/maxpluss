export type SmokeObject = Record<string, unknown>

export interface SmokeListShape {
  data: SmokeObject[]
  total?: number
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function bodyPreview(body: unknown): string {
  return JSON.stringify(body).slice(0, 300)
}

export function isObject(value: unknown): value is SmokeObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function field(source: unknown, key: string): unknown {
  return isObject(source) ? source[key] : undefined
}

export function valueAt(source: unknown, path: readonly string[]): unknown {
  let current: unknown = source
  for (const key of path) {
    current = field(current, key)
  }
  return current
}

export function stringField(source: unknown, key: string): string {
  const value = field(source, key)
  return typeof value === 'string' ? value : ''
}

export function booleanField(source: unknown, key: string): boolean | undefined {
  const value = field(source, key)
  return typeof value === 'boolean' ? value : undefined
}

export function numberField(source: unknown, key: string): number | undefined {
  const value = field(source, key)
  return typeof value === 'number' ? value : undefined
}

export function stringAt(source: unknown, path: readonly string[]): string {
  const value = valueAt(source, path)
  return typeof value === 'string' ? value : ''
}

export function objectAt(source: unknown, path: readonly string[]): SmokeObject | undefined {
  const value = valueAt(source, path)
  return isObject(value) ? value : undefined
}

export function arrayField(source: unknown, key: string): unknown[] | undefined {
  const value = field(source, key)
  return Array.isArray(value) ? value : undefined
}

export function arrayAt(source: unknown, path: readonly string[]): unknown[] | undefined {
  const value = valueAt(source, path)
  return Array.isArray(value) ? value : undefined
}

export function asArray(source: unknown): unknown[] {
  return Array.isArray(source) ? source : []
}

export function hasOwnField(source: unknown, key: string): boolean {
  return isObject(source) && Object.prototype.hasOwnProperty.call(source, key)
}

export function listShape(body: unknown): SmokeListShape {
  if (isObject(body)) {
    const total = numberField(body, 'total')
    const data = arrayField(body, 'data') ?? arrayField(body, 'items') ?? []
    return { data: data.filter(isObject), total }
  }
  if (Array.isArray(body)) return { data: body.filter(isObject) }
  return { data: [] }
}

export function firstId(list: readonly SmokeObject[], key = 'id'): string {
  const row = list.find((item) => typeof item[key] === 'string')
  return row ? String(row[key]) : ''
}

export function firstNestedString(list: readonly SmokeObject[], path: readonly string[]): string {
  for (const row of list) {
    const value = valueAt(row, path)
    if (typeof value === 'string') return value
  }
  return ''
}
