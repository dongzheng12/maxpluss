const assert = require('node:assert/strict')
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

test('indexnow dry-run lists unpushed URLs without updating dedupe state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bxz-indexnow-'))
  const urls = join(dir, 'urls.txt')
  const pushed = join(dir, 'pushed.txt')
  const logs = join(dir, 'logs')

  writeFileSync(urls, [
    'https://example.test/a',
    'https://example.test/b',
    'https://example.test/c',
    '',
  ].join('\n'))
  writeFileSync(pushed, 'https://example.test/a\n')

  const result = spawnSync('bash', [
    'scripts/indexnow-push.sh',
    '--dry-run',
    '--limit=2',
    `--urls-file=${urls}`,
    `--pushed-file=${pushed}`,
    `--log-dir=${logs}`,
  ], {
    cwd: join(__dirname, '..'),
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /选出 2 条待推送/)
  assert.match(result.stdout, /https:\/\/example\.test\/b/)
  assert.match(result.stdout, /https:\/\/example\.test\/c/)
  assert.equal(readFileSync(pushed, 'utf8'), 'https://example.test/a\n')
})
