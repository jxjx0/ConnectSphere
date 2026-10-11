import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { transformWithEsbuild } from 'vite'
import * as jsxRuntime from 'react/jsx-runtime'
import { venueBlockPayload } from '../src/venueBlock.js'
import { formatDateRange } from '../src/eventDisplay.js'

const form = { startDate: '2026-11-07', startTime: '10:00', endDate: '2026-11-07', endTime: '12:00', reason: ' Maintenance ' }

test('Singapore local block times convert to UTC for same-day and multi-date periods', () => {
  const helper = new URL('../src/venueBlock.js', import.meta.url).href
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { venueBlockPayload } from ${JSON.stringify(helper)};
    const form = ${JSON.stringify(form)};
    assert.deepEqual(venueBlockPayload(form), { start_at: '2026-11-07T02:00:00.000Z', end_at: '2026-11-07T04:00:00.000Z', block_reason: 'Maintenance' });
    for (const endDate of ['2026-11-08', '2026-11-09']) {
      const payload = venueBlockPayload({ ...form, startTime: '22:00', endDate, endTime: '02:00' });
      assert.equal(payload.start_at, '2026-11-07T14:00:00.000Z');
      assert.equal(payload.end_at, new Date(endDate + 'T02:00:00+08:00').toISOString());
    }
  `], { env: { ...process.env, TZ: 'Asia/Singapore' }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

for (const changes of [
  { startDate: '' }, { startDate: '2026-02-30' }, { endDate: 'bad' },
  { startTime: '24:00' }, { endTime: '10:00' }, { endTime: '09:00' },
  { endDate: '2026-11-06' }, { reason: ' ' }, { reason: 'x'.repeat(501) },
]) {
  test(`invalid block form is rejected: ${JSON.stringify(changes).slice(0, 85)}`, () => {
    assert.throws(() => venueBlockPayload({ ...form, ...changes }))
  })
}

const source = await readFile(new URL('../src/components/BlockForm.jsx', import.meta.url), 'utf8')
const { code } = await transformWithEsbuild(source, 'BlockForm.jsx', { jsx: 'automatic', format: 'cjs', tsconfigRaw: '{}' })

function harness(create = async () => ({ block: { block_id: 'block-1' }, booking_impact: { status: 'unavailable', affected_bookings: null } }), input = form, onCreated) {
  let index = 0
  let closed = 0
  const states = [input.startDate, input.startTime, input.endDate, input.endTime, input.reason, '', false, null]
  const dialogRef = { current: null }
  const effects = []
  const module = { exports: {} }
  const imports = {
    react: { ...React, useRef: () => dialogRef, useEffect: (effect) => effects.push(effect), useState: () => {
      const current = index++
      return [states[current], (value) => { states[current] = value }]
    } },
    'react/jsx-runtime': jsxRuntime,
    '../context/AuthContext': { useAuth: () => ({ token: 'staff-token' }) },
    '../api/venues': { createVenueBlock: create },
    '../venueBlock.js': { venueBlockPayload },
    '../eventDisplay.js': { formatDateRange },
  }
  new Function('require', 'module', 'exports', code)((name) => {
    assert.ok(name in imports, `unexpected import: ${name}`)
    return imports[name]
  }, module, module.exports)
  const props = { venue: { id: 'hall', name: 'Grand Hall' }, onClose: () => { closed++ }, onCreated }
  return {
    states,
    closed: () => closed,
    open: (dialog) => {
      index = 0; effects.length = 0
      module.exports.default(props)
      dialogRef.current = dialog
      return effects[0]()
    },
    tree: () => { index = 0; return module.exports.default(props) },
    html: () => { index = 0; return renderToStaticMarkup(React.createElement(module.exports.default, props)) },
  }
}

function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean)
  if (!React.isValidElement(node)) return undefined
  return predicate(node) ? node : find(node.props.children, predicate)
}

async function submit(page) {
  await find(page.tree(), (node) => node.type === 'form').props.onSubmit({ preventDefault() {} })
}

test('creation callback runs after confirmed persistence, never for errors or cancellation', async () => {
  let created = 0
  const callback = () => { created++ }
  const success = harness(undefined, form, callback)
  await submit(success)
  assert.equal(created, 1)
  for (const create of [async () => { throw new Error('Failed') }, async () => ({})]) {
    const failed = harness(create, form, callback)
    await submit(failed)
    assert.equal(created, 1)
    assert.match(failed.html(), /role="alert"/)
  }
  const cancelled = harness(undefined, form, callback)
  find(cancelled.tree(), (node) => node.props.children === 'Cancel').props.onClick()
  assert.equal(created, 1)
})

test('saved block stays visible without unavailable impact information and can be closed', async () => {
  let payload
  const page = harness(async (venueId, data, token) => {
    assert.equal(venueId, 'hall')
    assert.equal(token, 'staff-token')
    payload = data
    return { block: { block_id: 'block-1' }, booking_impact: { status: 'unavailable', affected_bookings: null } }
  })
  await submit(page)
  assert.equal(payload.block_reason, 'Maintenance')
  assert.match(payload.start_at, /Z$/)
  assert.equal(page.closed(), 0)
  assert.match(page.html(), /Block created successfully/)
  assert.match(page.html(), /class="venue-block-dialog__venue">Grand Hall/)
  for (const line of formatDateRange(payload.start_at, payload.end_at).split(', ')) assert.ok(page.html().includes(line))
  assert.match(page.html(), /class="venue-block-dialog__reason">Maintenance/)
  assert.ok(!page.html().includes('hall'))
  assert.ok(!page.html().includes('Could not be fully verified yet'))
  assert.ok(!page.html().includes('Booking impact'))
  assert.ok(!page.html().includes('No existing bookings are affected'))
  assert.ok(!page.html().includes('Submit'))
  find(page.tree(), (node) => node.type === 'button').props.onClick()
  assert.equal(page.closed(), 1)
})

test('verified-zero response differs from missing or incomplete impact data', async () => {
  for (const impact of [undefined, { status: 'unavailable', affected_bookings: [] }, { status: 'verified', affected_bookings: null }, { status: 'verified', affected_bookings: [] }]) {
    const page = harness(async () => ({ block: { block_id: 'block-1' }, booking_impact: impact }))
    await submit(page)
    const verified = impact?.status === 'verified' && Array.isArray(impact.affected_bookings)
    assert.equal(page.html().includes('No existing bookings are affected.'), verified)
    assert.ok(!page.html().includes('Could not be fully verified yet'))
    assert.equal(page.html().includes('Booking impact'), verified)
  }
})

test('success summary prefers saved values and shows both dates for a multi-date block', async () => {
  const saved = {
    block_id: 'block-1', venue_id: 'hall', start_at: '2026-11-10T12:00:00Z',
    end_at: '2026-11-11T12:00:00Z', block_reason: 'Saved maintenance reason',
  }
  const page = harness(async () => ({ block: saved, booking_impact: { status: 'unavailable', affected_bookings: null } }))
  await submit(page)
  const html = page.html()
  for (const line of formatDateRange(saved.start_at, saved.end_at).split(' – ')) assert.ok(html.includes(line))
  assert.ok(html.includes('→ '))
  assert.match(html, /10 Nov 2026/)
  assert.match(html, /11 Nov 2026/)
  assert.match(html, /Saved maintenance reason/)
  assert.ok(!html.includes('Venue ID'))
  assert.ok(!html.includes('hall'))
  assert.equal(find(page.tree(), (node) => node.type === 'form'), undefined)
})

test('view supports supplied affected-booking summaries without claiming notification delivery', async () => {
  const page = harness(async () => ({ block: { block_id: 'block-1' }, booking_impact: {
    status: 'verified', affected_bookings: [{ booking_id: 'a', event_name: 'Workshop' }, { booking_id: 'b', event_name: 'Seminar' }],
  } }))
  await submit(page)
  assert.match(page.html(), /2 existing bookings affected/)
  assert.match(page.html(), /Workshop/)
  assert.match(page.html(), /Seminar/)
  assert.ok(!page.html().includes('notified'))
})

test('backend errors and unconfirmed responses retain the form without false success', async () => {
  for (const create of [async () => { throw new Error('Unable to create the venue block.') }, async () => ({})]) {
    const page = harness(create)
    await submit(page)
    assert.match(page.html(), /role="alert"/)
    assert.ok(!page.html().includes('Block created'))
    assert.equal(page.closed(), 0)
    assert.equal(page.states[6], false)
    assert.equal(page.states[0], form.startDate)
  }
})

test('invalid form does not call the API and submitting disables mutable fields', async () => {
  const page = harness(() => assert.fail('invalid period must not reach API'), { ...form, endTime: '09:00' })
  await submit(page)
  assert.match(page.html(), /end time must be after start time/)
  page.states[6] = true
  for (const id of ['blockStartDate', 'blockStartTime', 'blockEndDate', 'blockEndTime', 'blockReason']) {
    assert.equal(find(page.tree(), (node) => node.props.id === id).props.disabled, true)
  }
})

test('modal has an accessible title, read-only venue text and exactly five editable fields', () => {
  const page = harness()
  const dialog = find(page.tree(), (node) => node.type === 'dialog')
  assert.equal(dialog.props['aria-labelledby'], 'blockVenueTitle')
  const html = page.html()
  assert.match(html, /id="blockVenueTitle">Block Venue/)
  assert.match(html, /<strong>Venue:<\/strong> Grand Hall/)
  assert.ok(!html.includes('Venue ID'))
  assert.ok(!html.includes('value="hall"'))
  assert.ok(!html.includes('value="Grand Hall"'))
  assert.equal((html.match(/<input/g) || []).length, 5)
  assert.match(html, /Specify when and why this venue should be unavailable/)
  assert.ok(html.indexOf('id="blockVenueTitle"') < html.indexOf('Specify when'))
  assert.ok(html.indexOf('Specify when') < html.indexOf('<strong>Venue:</strong>'))
  assert.equal(find(page.tree(), (node) => node.props.id === 'blockVenueTitle').props.className, 'venue-block-dialog__title')
  assert.ok(!html.includes('Times use your local timezone.'))
  assert.equal(find(page.tree(), (node) => node.props.id === 'blockStartDate').props.autoFocus, true)
  assert.equal(find(page.tree(), (node) => node.props.type === 'submit').props.children, 'Block Venue')
})

test('modal opens natively and restores focus when removed; Cancel and Escape close without submitting', () => {
  const page = harness(() => assert.fail('closing must not submit'))
  let opened = 0
  let restored = 0
  let dialogClosed = 0
  const cleanup = page.open({
    ownerDocument: { activeElement: { focus: () => restored++ } },
    showModal: () => opened++, close: () => dialogClosed++,
  })
  assert.equal(opened, 1)
  find(page.tree(), (node) => node.type === 'button' && node.props.children === 'Cancel').props.onClick()
  assert.equal(page.closed(), 1)
  find(page.tree(), (node) => node.type === 'dialog').props.onCancel()
  assert.equal(page.closed(), 2)
  cleanup()
  assert.equal(dialogClosed, 1)
  assert.equal(restored, 1)
})

test('backend error keeps the dialog open and a retry can succeed with entered values', async () => {
  let calls = 0
  const page = harness(async () => {
    if (++calls === 1) throw new Error('Unable to create the venue block.')
    return { block: { block_id: 'saved' }, booking_impact: { status: 'unavailable', affected_bookings: null } }
  })
  await submit(page)
  assert.ok(find(page.tree(), (node) => node.type === 'dialog'))
  assert.equal(page.closed(), 0)
  assert.equal(page.states[4], form.reason)
  await submit(page)
  assert.match(page.html(), /Block created successfully/)
  assert.ok(!page.html().includes('Unable to create'))
})

test('catalogue Block action selects the correct venue and closing unmounts the form', async () => {
  const source = await readFile(new URL('../src/pages/VenuePage.jsx', import.meta.url), 'utf8')
  const compiled = await transformWithEsbuild(source, 'VenuePage.jsx', { jsx: 'automatic', format: 'cjs', tsconfigRaw: '{}' })
  const venues = ['First Hall', 'Second Hall'].map((name, index) => ({
    id: `venue-${index}`, name, operating_hours: { open: '09:00', close: '18:00' }, capacity: 100, layouts: [],
  }))
  const states = [{ name: '', location: '', capacity: '', facilities: [], accessibility: [], layouts: [], open: '', close: '' }, venues, '', '', false, false, null, [], '']
  let index = 0
  const BlockForm = () => null
  const module = { exports: {} }
  const imports = {
    react: { ...React, useEffect: () => {}, useState: () => {
      const current = index++
      return [states[current], (value) => { states[current] = value }]
    } },
    'react/jsx-runtime': jsxRuntime,
    'react-router-dom': { Link: 'a', useNavigate: () => () => {}, useParams: () => ({}) },
    '../api/venues': {}, '../validation': {},
    '../components/AppShell': { __esModule: true, default: 'main' },
    '../components/BlockForm': { __esModule: true, default: BlockForm },
    '../context/AuthContext': { useAuth: () => ({ token: 'token' }) },
  }
  new Function('require', 'module', 'exports', compiled.code)((name) => {
    assert.ok(name in imports, `unexpected import ${name}`)
    return imports[name]
  }, module, module.exports)
  function tree(props = {}) { index = 0; return module.exports.default(props) }
  const header = find(tree(), (node) => node.props.className === 'content__header venue-search__header')
  const backLink = find(header, (node) => node.props.className === 'venue-search__back')
  assert.equal(backLink.props.to, '/dashboard')
  assert.equal(header.props.children[0], backLink)
  assert.equal(find(header, (node) => node.type === 'h1').props.children, 'Venue Catalogue')
  const row = find(tree(), (node) => node.type === 'tr' && node.key === 'venue-1')
  const blockButton = find(row, (node) => node.type === 'button' && node.props.children === 'Block')
  const editLink = find(row, (node) => node.props.children === 'Edit')
  const availabilityLink = find(row, (node) => node.props.children === 'View Availability')
  const availabilityUrl = new URL(availabilityLink.props.to, 'http://localhost')
  assert.equal(availabilityUrl.pathname, '/venues/availability')
  assert.equal(availabilityUrl.searchParams.get('venueId'), 'venue-1')
  assert.equal(availabilityUrl.searchParams.get('from'), 'catalogue')
  assert.equal(blockButton.props.className, editLink.props.className)
  assert.equal(blockButton.props.disabled, false)
  blockButton.props.onClick()
  const modal = find(tree(), (node) => node.type === BlockForm)
  assert.equal(modal.props.venue, venues[1])
  modal.props.onClose()
  assert.equal(states[6], null)
  assert.equal(find(tree(), (node) => node.type === BlockForm), undefined)
  const createHeader = find(tree({ createMode: true }), (node) => node.props.className === 'content__header venue-search__header')
  const createBackLink = find(createHeader, (node) => node.props.className === 'venue-search__back')
  assert.equal(createBackLink.props.to, '/venues')
  assert.equal(createHeader.props.children[0], createBackLink)
  assert.equal(find(createHeader, (node) => node.type === 'h1').props.children, 'Create Venue Profile')
})
