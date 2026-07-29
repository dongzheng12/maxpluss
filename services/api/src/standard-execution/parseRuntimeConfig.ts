const DEFAULT_AI_PARSE_CHUNK_CHARS = 8000
const DEFAULT_AI_PARSE_CONCURRENCY = 3
const MAX_AI_PARSE_CONCURRENCY = 6
const DEFAULT_REALTIME_AI_MAX_CHUNKS = 6
const DEFAULT_CANDIDATE_MIN_SCORE = 60
const DEFAULT_TASK_MIN_SCORE = 75
const DEFAULT_TASK_PACKAGE_MAX = 12
const MAX_TASK_PACKAGE_MAX = 15

function positiveIntFromEnv(name: string, fallback: number) {
  const raw = Number(process.env[name])
  if (!Number.isFinite(raw) || raw < 1) return fallback
  return Math.floor(raw)
}

function scoreFromEnv(name: string, fallback: number) {
  const raw = Number(process.env[name])
  if (!Number.isFinite(raw)) return fallback
  return Math.min(100, Math.max(0, Math.floor(raw)))
}

export function getAiParseChunkChars() {
  return positiveIntFromEnv('STANDARD_AI_PARSE_CHUNK_CHARS', DEFAULT_AI_PARSE_CHUNK_CHARS)
}

export function getAiParseConcurrency() {
  const raw = positiveIntFromEnv('STANDARD_AI_PARSE_CONCURRENCY', DEFAULT_AI_PARSE_CONCURRENCY)
  return Math.min(MAX_AI_PARSE_CONCURRENCY, raw)
}

export function getRealtimeAiMaxChunks() {
  return positiveIntFromEnv('STANDARD_AI_REALTIME_MAX_CHUNKS', DEFAULT_REALTIME_AI_MAX_CHUNKS)
}

export function getRealtimeAiMaxChars() {
  const fallback = getAiParseChunkChars() * getRealtimeAiMaxChunks()
  return positiveIntFromEnv('STANDARD_AI_REALTIME_MAX_CHARS', fallback)
}

export function getCandidateRequirementMinScore() {
  return scoreFromEnv('STANDARD_AI_CANDIDATE_MIN_SCORE', DEFAULT_CANDIDATE_MIN_SCORE)
}

export function getCandidateTaskMinScore() {
  return scoreFromEnv('STANDARD_AI_TASK_MIN_SCORE', DEFAULT_TASK_MIN_SCORE)
}

export function getCandidateTaskPackageMax() {
  const raw = positiveIntFromEnv('STANDARD_AI_TASK_PACKAGE_MAX', DEFAULT_TASK_PACKAGE_MAX)
  return Math.min(MAX_TASK_PACKAGE_MAX, raw)
}

export function isCandidateV2Enabled() {
  return process.env.STANDARD_AI_CANDIDATE_V2 === '1'
}

export function getTaskGenerationRuntimeConfig() {
  const aiChunkChars = getAiParseChunkChars()
  const realtimeAiMaxChunks = getRealtimeAiMaxChunks()
  const realtimeAiMaxChars = getRealtimeAiMaxChars()
  return {
    aiChunkChars,
    aiConcurrency: getAiParseConcurrency(),
    realtimeAiMaxChunks,
    realtimeAiMaxChars,
    candidateMinScore: getCandidateRequirementMinScore(),
    candidateTaskMinScore: getCandidateTaskMinScore(),
    candidateTaskPackageMax: getCandidateTaskPackageMax(),
    candidateV2Enabled: isCandidateV2Enabled(),
  }
}
