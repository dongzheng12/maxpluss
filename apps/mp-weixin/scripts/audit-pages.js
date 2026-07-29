#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const appJsonPath = path.join(root, 'app.json')
const projectConfigPath = path.join(root, 'project.config.json')

const REQUIRED_EMPLOYEE_PAGES = [
  'pages/standard-execution/tasks/index',
  'pages/standard-execution/task-detail/index',
  'pages/standard-execution/submit/index',
  'pages/standard-execution/quiz/index',
  'pages/standard-execution/records/index',
]

const EXPECTED_APPID = 'wxbcda91ae07a75f66'

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function assert(condition, message, failures) {
  if (!condition) failures.push(message)
}

const failures = []
const appJson = readJson(appJsonPath)
const projectConfig = readJson(projectConfigPath)
const pages = Array.isArray(appJson.pages) ? appJson.pages : []
const pageSet = new Set(pages)
const configJs = fs.readFileSync(path.join(root, 'utils/config.js'), 'utf8')
const loginWxml = fs.readFileSync(path.join(root, 'pages/login/index.wxml'), 'utf8')
const registerWxml = fs.readFileSync(path.join(root, 'pages/register/index.wxml'), 'utf8')

assert(projectConfig.appid === EXPECTED_APPID, `appid mismatch: expected ${EXPECTED_APPID}, got ${projectConfig.appid}`, failures)

REQUIRED_EMPLOYEE_PAGES.forEach((page) => {
  assert(pageSet.has(page), `missing employee page registration: ${page}`, failures)
})

assert(loginWxml.includes('data-tab="personal"') && loginWxml.includes('data-tab="enterprise"'), 'login page must expose personal and enterprise tabs', failures)
assert(registerWxml.includes('data-tab="personal"') && registerWxml.includes('data-tab="enterprise"'), 'register page must expose personal and enterprise tabs', failures)
assert(registerWxml.includes('goEnterpriseLogin') && registerWxml.includes('goEnterpriseApply'), 'register page must expose enterprise login/apply entries', failures)
const blockedApiPattern = new RegExp('80' + '83|' + 'local' + 'host|http' + '://|154\\.8\\.197\\.13|43\\.130\\.14\\.129')

assert(configJs.includes("const PROD_API = 'https://api.biaozhunxiaozhi.com'"), 'config.js must use production HTTPS API', failures)
assert(!blockedApiPattern.test(configJs), 'config.js must not contain blocked debug API endpoints', failures)
assert(configJs.includes('SE_UI_ENABLED: true'), 'SE_UI_ENABLED must stay enabled for the authoritative full mini-program source', failures)
assert(registerWxml.includes('toggleAgreed') && registerWxml.includes('goTerms') && registerWxml.includes('goPrivacy'), 'register page must require terms/privacy agreement links', failures)

pages.forEach((page) => {
  ;['js', 'json', 'wxml', 'wxss'].forEach((ext) => {
    const file = path.join(root, `${page}.${ext}`)
    assert(fs.existsSync(file), `registered page is missing .${ext}: ${page}`, failures)
  })
})

if (failures.length) {
  console.error(`mp page audit failed: ${failures.length} issue(s)`)
  failures.forEach((failure) => console.error(`- ${failure}`))
  process.exit(1)
}

console.log(`mp page audit passed: ${pages.length} registered pages, ${REQUIRED_EMPLOYEE_PAGES.length} employee pages, appid ${EXPECTED_APPID}`)
