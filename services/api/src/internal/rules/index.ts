/**
 * 规则注册表 — ruleId → query() 映射
 * 新增规则时：新建 RNN.ts 实现 query() 后在此加一行 import
 */
import type { RuleQuery } from './types.js'
import { query as R01 } from './R01.js'
import { query as R02 } from './R02.js'
import { query as R03 } from './R03.js'
import { query as R04 } from './R04.js'
import { query as R05 } from './R05.js'
import { query as R06 } from './R06.js'
import { query as R07 } from './R07.js'
import { query as R08 } from './R08.js'
import { query as R09 } from './R09.js'
import { query as R10 } from './R10.js'
import { query as R11 } from './R11.js'
import { query as R12 } from './R12.js'
import { query as R13 } from './R13.js'
import { query as R14 } from './R14.js'
import { query as R15 } from './R15.js'

export const RULES: Record<string, RuleQuery> = {
  R01, R02, R03, R04, R05, R06, R07, R08, R09, R10, R11, R12, R13, R14, R15,
}

export function isKnownRule(ruleId: string): boolean {
  return Object.prototype.hasOwnProperty.call(RULES, ruleId)
}
