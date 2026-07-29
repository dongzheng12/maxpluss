import { Prisma } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { CLEAN_STANDARD_EXECUTION_MODEL_DELEGATES } from './seClean.js'

function toDelegateName(modelName: string) {
  return `${modelName.slice(0, 1).toLowerCase()}${modelName.slice(1)}`
}

describe('cleanStandardExecutionData coverage', () => {
  it('covers every standard-execution Prisma model', () => {
    const runtimeSeDelegates = Prisma.dmmf.datamodel.models
      .map((model) => toDelegateName(model.name))
      .filter((name) => name.startsWith('standardExecution') || name.startsWith('sE'))
      .sort()
    const configuredDelegates = [...CLEAN_STANDARD_EXECUTION_MODEL_DELEGATES].sort()
    const missing = runtimeSeDelegates.filter((name) => !configuredDelegates.includes(name as never))

    expect(
      missing,
      `新 SE 表必须按 FK 拓扑序加进 seClean.ts：${missing.join(', ') || '(none)'}`,
    ).toEqual([])
  })
})
