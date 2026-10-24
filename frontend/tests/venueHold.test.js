import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { transformWithEsbuild } from 'vite'
import * as jsxRuntime from 'react/jsx-runtime'
import * as helpers from '../src/venueBlock.js'
import * as display from '../src/eventDisplay.js'
import * as blockHelpers from '../src/venueBlock.js'

const fields = { eventId: 'event-1', startDate: '2099-11-07', startTime: '10:00',
  endDate: '2099-11-07', endTime: '12:00', expiryDate: '2099-11-06', expiryTime: '12:00' }
const venue = { id: 'hall', name: 'Grand Hall', setup_time_minutes: 30 }

test('hold payload uses local dates and explicit UTC without an operational reason', () => {
  const data = helpers.venueHoldPayload(fields, 30)
  assert.equal(data.event_id, fields.eventId)
  assert.equal(data.start_at, new Date('2099-11-07T10:00').toISOString())
  assert.equal(data.expires_at, new Date('2099-11-06T12:00').toISOString())
  assert.equal(data.block_reason, undefined)
})

for (const change of [{ eventId: '' }, { endTime: '09:00' }, { expiryDate: '2000-01-01' },
  { expiryDate: '2099-11-07', expiryTime: '09:31' }, { startDate: '2099-02-30' }]) {
  test(`invalid hold fields: ${JSON.stringify(change)}`, () => {
    assert.throws(() => helpers.venueHoldPayload({ ...fields, ...change }, 30))
  })
}
test('expiry may exactly touch setup start; unknown buffers are not zero', () => {
  assert.ok(helpers.venueHoldPayload({ ...fields, expiryDate: '2099-11-07', expiryTime: '09:30' }, 30))
  assert.throws(() => helpers.venueHoldPayload(fields, undefined), /unavailable/)
})

const source = await readFile(new URL('../src/components/BlockForm.jsx', import.meta.url), 'utf8')
const { code } = await transformWithEsbuild(source, 'BlockForm.jsx', { format: 'cjs', jsx: 'automatic', tsconfigRaw: '{}' })
function find(node, predicate) {
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean)
  if (!React.isValidElement(node)) return undefined
  return predicate(node) ? node : find(node.props.children, predicate)
}
function harness({ events = async () => ({ events: [{ id: 'event-1', name: 'Workshop' }] }),
  create = async (id, payload) => ({ hold: { hold_id: 'hold-1', ...payload }, notification_status: 'saved' }) } = {}) {
  const states = [], effects = [], calls = []
  let index = 0, created = 0, closed = 0
  const module = { exports: {} }
  const imports = {
    react: { ...React, useRef: () => ({ current: null }), useEffect: fn => effects.push(fn), useState(initial) {
      const position = index++
      if (!(position in states)) states[position] = initial
      return [states[position], value => { states[position] = typeof value === 'function' ? value(states[position]) : value }]
    } },
    'react/jsx-runtime': jsxRuntime,
    '../context/AuthContext': { useAuth: () => ({ token: 'token' }) },
    '../api/venues': { getVenueHoldEvents: events, createVenueHold: async (...args) => { calls.push(args); return create(...args) },
      createVenueBlock: async () => assert.fail('hold must not use block endpoint') },
    '../venueBlock.js': blockHelpers, '../eventDisplay.js': display,
  }
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name in imports, `unexpected import ${name}`); return imports[name]
  }, module, module.exports)
  const tree = () => { index = 0; effects.length = 0; return module.exports.default({ venue, onCreated: () => created++, onClose: () => closed++ }) }
  return { tree, calls, html: () => renderToStaticMarkup(tree()), created: () => created,
    field: id => find(tree(), node => node.props.id === id),
    load: async () => {
      find(tree(), node => node.props.type === 'radio' && node.props.value === 'tentative_hold').props.onChange()
      tree(); effects[1](); await new Promise(resolve => setImmediate(resolve))
    },
    fill: () => {
      for (const [key, value] of Object.entries(fields)) {
        const id = { eventId: 'holdEvent', startDate: 'blockStartDate', startTime: 'blockStartTime',
          endDate: 'blockEndDate', endTime: 'blockEndTime', expiryDate: 'holdExpiryDate', expiryTime: 'holdExpiryTime' }[key]
        find(tree(), node => node.props.id === id).props.onChange({ target: { value } })
      }
    },
    submit: () => find(tree(), node => node.type === 'form').props.onSubmit({ preventDefault() {} }),
  }
}

test('staff hold form loads events and submits once with concise outcome', async () => {
  const page = harness()
  assert.match(page.html(), /Operational Unavailability/)
  assert.equal(page.field('holdExpiryDate'), undefined)
  await page.load()
  assert.match(page.html(), /Workshop/)
  assert.doesNotMatch(page.html(), /Reason|Maintenance/)
  page.fill()
  await page.submit()
  assert.equal(page.created(), 1)
  assert.equal(page.calls[0][0], venue.id)
  assert.equal(page.calls[0][2], 'token')
  assert.equal(page.calls[0][1].event_id, 'event-1')
  assert.match(page.html(), /Hold created/)
  assert.match(page.html(), /Coordinator notified/)
  assert.equal(find(page.tree(), node => node.type === 'form'), undefined)
})

test('hold form keeps input and does not claim success on conflict', async () => {
  const page = harness({ create: async () => { throw new Error('Venue unavailable') } })
  await page.load(); page.fill(); await page.submit()
  assert.match(page.html(), /role="alert"/)
  assert.match(page.html(), /Venue unavailable/)
  assert.equal(page.field('blockStartTime').props.value, '10:00')
  assert.equal(page.created(), 0)
})

test('saved hold remains successful if Coordinator notification failed', async () => {
  const page = harness({ create: async (id, payload) => ({ hold: { hold_id: 'hold-1', ...payload }, notification_status: 'failed' }) })
  await page.load(); page.fill(); await page.submit()
  assert.match(page.html(), /Hold created/)
  assert.match(page.html(), /could not be notified/)
  assert.equal(page.created(), 1)
})

test('type choice toggles relevant fields and preserves the shared period', async () => {
  const page = harness()
  page.field('blockReason').props.onChange({ target: { value: 'Maintenance' } })
  await page.load()
  page.fill()
  assert.equal(page.field('blockReason'), undefined)
  assert.ok(page.field('holdEvent'))
  assert.ok(page.field('holdExpiryDate'))
  find(page.tree(), node => node.props.type === 'radio' && node.props.value === 'operational_block').props.onChange()
  assert.equal(page.field('holdEvent'), undefined)
  assert.equal(page.field('holdExpiryDate'), undefined)
  assert.equal(page.field('blockReason').props.value, 'Maintenance')
  assert.equal(page.field('blockStartTime').props.value, '10:00')
  assert.equal(page.field('blockEndTime').props.value, '12:00')
  assert.equal(page.calls.length, 0)
})

test('event loading failure disables creation and is visible', async () => {
  const page = harness({ events: async () => { throw new Error('Unable to load events') } })
  await page.load()
  assert.match(page.html(), /role="alert"/)
  assert.equal(find(page.tree(), node => node.type === 'button' && node.props.children === 'Create hold').props.disabled, true)
  assert.equal(page.calls.length, 0)
})

test('existing booking form includes assigned confirmed events for hold conversion', async () => {
  const source = await readFile(new URL('../src/components/BookingForm.jsx', import.meta.url), 'utf8')
  const { code } = await transformWithEsbuild(source, 'BookingForm.jsx', { format: 'cjs', jsx: 'automatic', tsconfigRaw: '{}' })
  const states = [], effects = [], module = { exports: {} }
  let index = 0, writes = 0
  const imports = {
    react: { ...React, useEffect: fn => effects.push(fn), useState(initial) {
      const position = index++
      if (!(position in states)) states[position] = initial
      return [states[position], value => { states[position] = typeof value === 'function' ? value(states[position]) : value }]
    } },
    'react/jsx-runtime': jsxRuntime,
    '../context/AuthContext': { useAuth: () => ({ token: 'token' }) },
    '../api/events': { getAssignedEventRequests: async () => ({ events: [
      { id: 'confirmed', name: 'Confirmed event', status: 'confirmed' },
      { id: 'completed', name: 'Completed event', status: 'completed' },
    ] }) },
    '../api/venues': { createVenueBooking: async () => { writes++ } },
    '../venueSearch': { preferredLayout: () => '' },
  }
  new Function('require', 'module', 'exports', code)(name => imports[name], module, module.exports)
  module.exports.default({ venue })
  effects[0]()
  await new Promise(resolve => setImmediate(resolve))
  index = 0
  const html = renderToStaticMarkup(module.exports.default({ venue }))
  assert.match(html, /Confirmed event/)
  assert.doesNotMatch(html, /Completed event/)
  assert.equal(writes, 0)
})
