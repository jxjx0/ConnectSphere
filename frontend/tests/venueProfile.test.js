import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { transformWithEsbuild } from 'vite'
import * as jsxRuntime from 'react/jsx-runtime'
import * as categories from '../src/eventCategories.js'

const validationSource = await readFile(new URL('../src/validation.js', import.meta.url), 'utf8')
const validationCode = await transformWithEsbuild(validationSource, 'validation.js', { format: 'cjs', tsconfigRaw: '{}' })
const validationModule = { exports: {} }
new Function('require', 'module', 'exports', validationCode.code)(() => categories, validationModule, validationModule.exports)
const validation = validationModule.exports
const source = await readFile(new URL('../src/pages/VenuePage.jsx', import.meta.url), 'utf8')
const { code } = await transformWithEsbuild(source, 'VenuePage.jsx', { jsx: 'automatic', format: 'cjs', tsconfigRaw: '{}' })
const venue = {
  id: 'hall', name: 'Hall', location: 'West', capacity: 100, facilities: [], accessibility: [],
  layouts: [{ name: 'Theatre', capacity: 100 }], operating_hours: { open: '09:00', close: '18:00' },
  setup_time_minutes: 30, turnaround_time_minutes: 45,
}

function harness({ edit = false, history = [], updateResult } = {}) {
  const states = [], writes = [], navigations = []
  let index = 0, effects = [], routeVenueId = edit ? 'hall' : undefined
  const props = { createMode: !edit }
  const module = { exports: {} }
  const imports = {
    react: { ...React, useState: (initial) => {
      const i = index++
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial
      return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value }]
    }, useEffect: fn => effects.push(fn) },
    'react/jsx-runtime': jsxRuntime,
    'react-router-dom': { Link: ({ to, children }) => React.createElement('a', { href: to }, children),
      useNavigate: () => path => navigations.push(path), useParams: () => routeVenueId ? { venueId: routeVenueId } : {} },
    '../api/venues': {
      getVenues: async () => ({ venues: [venue] }), getVenueHistory: async () => ({ history }),
      createVenue: async (payload, token) => writes.push({ payload, token }),
      updateVenue: async (id, payload, token) => {
        writes.push({ id, payload, token })
        return updateResult
      },
    },
    '../validation': validation,
    '../components/AppShell': { __esModule: true, default: ({ children }) => React.createElement('main', null, children) },
    '../components/BlockForm': { __esModule: true, default: () => null },
    '../context/AuthContext': { useAuth: () => ({ token: 'token' }) },
  }
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name in imports, `unexpected import ${name}`)
    return imports[name]
  }, module, module.exports)
  function tree() { index = 0; effects = []; return module.exports.default(props) }
  function find(node, predicate) {
    if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean)
    if (!React.isValidElement(node)) return undefined
    return predicate(node) ? node : find(node.props.children, predicate)
  }
  return {
    states, writes, navigations, tree,
    changeRoute: (id, createMode = false) => { routeVenueId = id; props.createMode = createMode },
    html: () => renderToStaticMarkup(tree()),
    field: id => find(tree(), node => node.props.id === id),
    button: label => find(tree(), node => node.type === 'button' && node.props.children === label),
    submit: () => find(tree(), node => node.type === 'form').props.onSubmit({ preventDefault() {} }),
    load: async () => { tree(); effects[0](); await new Promise(resolve => setImmediate(resolve)) },
  }
}

test('new venue buffers start at zero and use accessible whole-minute controls', () => {
  const page = harness()
  page.tree()
  for (const id of ['setupTime', 'turnaroundTime']) {
    const field = page.field(id)
    assert.equal(field.props.value, '0')
    assert.equal(field.props.min, '0')
    assert.equal(field.props.step, '1')
    assert.equal(field.props.required, true)
    assert.equal(field.props['aria-describedby'], 'venueBufferHint')
  }
  assert.match(page.html(), /availability and conflict checks/)
})

for (const [setup, turnaround] of [['0', '0'], ['30', '45']]) {
  test(`create submits numeric buffer values ${setup}/${turnaround}`, async () => {
    const page = harness()
    page.tree()
    page.states[0] = { ...page.states[0], name: 'Hall', capacity: '100',
      layouts: [{ name: 'Theatre', capacity: '100' }], open: '09:00', close: '18:00' }
    page.field('setupTime').props.onChange({ target: { value: setup } })
    page.field('turnaroundTime').props.onChange({ target: { value: turnaround } })
    await page.submit()
    assert.equal(page.writes[0].payload.setup_time_minutes, Number(setup))
    assert.equal(page.writes[0].payload.turnaround_time_minutes, Number(turnaround))
    assert.equal(page.writes[0].token, 'token')
    assert.deepEqual(page.navigations, ['/venues'])
  })
}

test('edit populates persisted buffers and unrelated changes preserve both', async () => {
  const page = harness({ edit: true })
  await page.load()
  assert.equal(page.field('setupTime').props.value, '30')
  assert.equal(page.field('turnaroundTime').props.value, '45')
  page.field('venueName').props.onChange({ target: { value: 'Renamed Hall' } })
  await page.submit()
  assert.equal(page.writes[0].id, 'hall')
  assert.equal(page.writes[0].payload.name, 'Renamed Hall')
  assert.equal(page.writes[0].payload.setup_time_minutes, 30)
  assert.equal(page.writes[0].payload.turnaround_time_minutes, 45)
})

for (const id of ['setupTime', 'turnaroundTime']) {
  for (const value of ['', '-1', '1.5', '2147483648']) {
    test(`${id} rejects ${JSON.stringify(value)} without sending a request`, async () => {
      const page = harness({ edit: true })
      await page.load()
      page.field(id).props.onChange({ target: { value } })
      await page.submit()
      assert.equal(page.writes.length, 0)
      assert.match(page.html(), /must be a non-negative whole number/)
    })
  }
}

test('the final accessibility row can be removed and the venue saved without features', async () => {
  const page = harness({ edit: true })
  await page.load()
  page.button('Add accessibility feature').props.onClick()
  assert.deepEqual(page.states[0].accessibility, [''])
  await page.submit()
  assert.equal(page.writes.length, 0)
  assert.match(page.html(), /Accessibility features must not be blank/)
  page.button('Remove').props.onClick()
  assert.deepEqual(page.states[0].accessibility, [])
  await page.submit()
  assert.equal(page.writes.length, 1)
  assert.deepEqual(page.writes[0].payload.accessibility, [])
})

test('buffer audit history displays labels and minute values', async () => {
  const page = harness({ edit: true, history: [{ id: 'audit', changed_at: '2026-10-16T09:00Z',
    changed_by_name: 'Venue Staff', changed_fields: ['setup_time_minutes', 'turnaround_time_minutes'],
    old_values: { setup_time_minutes: 0, turnaround_time_minutes: 0 },
    new_values: { setup_time_minutes: 30, turnaround_time_minutes: 45 } }] })
  await page.load()
  assert.match(page.html(), /Setup time/)
  assert.match(page.html(), /Turnaround time/)
  assert.match(page.html(), /30 minutes/)
  assert.match(page.html(), /45 minutes/)
})

for (const status of ['verified', 'partial', 'unavailable']) {
  test(`buffer impact ${status} shows the saved outcome without encouraging another submission`, async () => {
    const affected = status === 'unavailable' ? null : [{ booking_id: 'booking', event_name: 'Workshop',
      effective_start: '2099-11-07T09:30:00+08:00', effective_end: '2099-11-07T12:45:00+08:00',
      status_update: status === 'verified' ? 'updated' : 'failed',
      notification_status: status === 'verified' ? 'saved' : 'failed' }]
    const page = harness({ edit: true, updateResult: { buffer_impact: { status, affected_bookings: affected } } })
    await page.load()
    page.field('setupTime').props.onChange({ target: { value: '60' } })
    await page.submit()
    const html = page.html()
    assert.match(html, /Venue updated/)
    assert.match(html, /Back to Venue Catalogue/)
    assert.doesNotMatch(html, /<form/)
    assert.deepEqual(page.navigations, [])
    assert.equal(page.writes.length, 1)
    if (status === 'verified') {
      assert.match(html, /Workshop/)
      assert.match(html, /Coordinators notified/)
    } else {
      assert.match(html, /Your venue changes are saved/)
      assert.doesNotMatch(html, /Coordinators notified/)
    }
    if (status === 'partial') {
      assert.match(html, /Booking status could not be verified/)
      assert.match(html, /Coordinator could not be notified/)
    }
  })
}

test('returning to catalogue and reopening an editor clears the previous impact result', async () => {
  const page = harness({ edit: true, updateResult: {
    buffer_impact: { status: 'verified', affected_bookings: [] },
  } })
  await page.load()
  page.field('setupTime').props.onChange({ target: { value: '60' } })
  await page.submit()
  assert.match(page.html(), /Venue updated/)
  assert.equal(page.field('setupTime'), undefined)
  page.changeRoute(undefined)
  await page.load()
  assert.doesNotMatch(page.html(), /Venue updated/)
  page.changeRoute('hall')
  await page.load()
  assert.ok(page.field('setupTime'))
  assert.doesNotMatch(page.html(), /No newly affected bookings/)
  page.changeRoute(undefined, true)
  await page.load()
  assert.ok(page.field('setupTime'))
})
