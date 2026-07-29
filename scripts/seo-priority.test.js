const assert = require('node:assert/strict')
const test = require('node:test')

const {
  normalizeDate,
  renderEntryPage,
  renderSitemap,
  xmlEscape,
} = require('./seo-priority.js')

test('normalizeDate accepts compact and partial dates', () => {
  assert.equal(normalizeDate('20240608'), '2024-06-08')
  assert.equal(normalizeDate('2024-06'), '2024-06-01')
  assert.equal(normalizeDate('2024'), '2024-01-01')
  assert.equal(normalizeDate('not-a-date'), '')
})

test('renderSitemap emits lastmod only when a valid date exists', () => {
  const xml = renderSitemap([
    { url: 'https://example.test/a?x=1&y=2', pub_date: '2024/06/08' },
    { url: 'https://example.test/b', pub_date: '' },
  ])

  assert.match(xml, /<loc>https:\/\/example\.test\/a\?x=1&amp;y=2<\/loc>/)
  assert.match(xml, /<lastmod>2024-06-08<\/lastmod>/)
  assert.match(xml, /<loc>https:\/\/example\.test\/b<\/loc>/)
  assert.equal(xml.match(/<lastmod>/g)?.length, 1)
})

test('renderEntryPage includes canonical priority entry and escaped links', () => {
  const html = renderEntryPage([
    {
      code: 'GB 1-2024',
      url: 'https://example.test/standards/gb-1-2024?x=1&y=2',
      fname: 'missing-title',
    },
  ], '/tmp/no-such-seo-dir', 'https://example.test')

  assert.match(html, /<link rel="canonical" href="https:\/\/example\.test\/standards-priority\.html">/)
  assert.match(html, /GB 1-2024/)
  assert.match(html, /https:\/\/example\.test\/standards\/gb-1-2024\?x=1&amp;y=2/)
})

test('xmlEscape covers HTML-sensitive characters', () => {
  assert.equal(xmlEscape(`a&b<c>"'`), 'a&amp;b&lt;c&gt;&quot;&apos;')
})
