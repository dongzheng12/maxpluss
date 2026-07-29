#!/usr/bin/env node

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const ignoreDirs = new Set(['node_modules', 'miniprogram_npm', '.git'])

function walk(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  entries.forEach((entry) => {
    if (ignoreDirs.has(entry.name)) return
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
      return
    }
    if (entry.isFile() && entry.name.endsWith('.js')) out.push(full)
  })
}

const files = []
walk(root, files)

const failures = []
files.sort().forEach((file) => {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) {
    failures.push({ file, stderr: result.stderr || result.stdout })
  }
})

if (failures.length) {
  console.error(`JS syntax check failed: ${failures.length}/${files.length}`)
  failures.forEach((failure) => {
    console.error(`\n${path.relative(root, failure.file)}`)
    console.error(failure.stderr.trim())
  })
  process.exit(1)
}

console.log(`JS syntax check passed: ${files.length} files`)
