// What Technical Support's pages and the Coordinator's request rows render.
// These render once on the server, so they cover the output for each state
// but not clicks or loading, which the helpers' tests and the backend cover.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as jsxRuntime from 'react/jsx-runtime'
import { transformWithEsbuild } from 'vite'

import * as catalogueHelpers from '../src/equipmentCatalogue.js'
import * as calendarHelpers from '../src/equipmentCalendar.js'
import * as display from '../src/eventDisplay.js'

const css = { __esModule: true, default: new Proxy({}, { get: (_, name) => String(name) }) }
const link = ({ to, children, ...props }) => React.createElement('a', { ...props, href: to }, children)

async function compile(path, imports = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  const { code } = await transformWithEsbuild(source, path, { format: 'cjs', jsx: 'automatic', tsconfigRaw: '{}' })
  const module = { exports: {} }
  const dependencies = {
    react: React,
    'react/jsx-runtime': jsxRuntime,
    '../equipmentCatalogue': catalogueHelpers,
    '../equipmentCalendar': calendarHelpers,
    '../eventDisplay': display,
    '../styles/TechSupport.module.css': css,
    ...imports,
  }
  new Function('require', 'module', 'exports', code)((name) => {
    assert.ok(name in dependencies, `unexpected dependency: ${name}`)
    return dependencies[name]
  }, module, module.exports)
  return module.exports
}

const render = (component, props) => renderToStaticMarkup(React.createElement(component, props))

const groups = [{ name: 'Projector', functional: 2 }, { name: 'Speaker', functional: 1 }]
const row = (changes = {}) => ({ ...catalogueHelpers.emptyLine(), ...changes })

test('request rows list types, and Other asks for a name', async () => {
  const { default: Lines } = await compile('../src/components/EquipmentLinesField.jsx')

  const html = render(Lines, { lines: [row({ choice: 'other' })], types: groups, onChange() {} })

  assert.match(html, /<option value="Projector">Projector<\/option>/)
  assert.match(html, /Other \(not listed\)/)
  assert.match(html, /What do you need\?/)
  assert.doesNotMatch(html, />Remove</)
})

test('request rows warn when more is asked for than the catalogue has', async () => {
  const { default: Lines } = await compile('../src/components/EquipmentLinesField.jsx')

  const over = render(Lines, { lines: [row({ choice: 'Projector', quantity: '3' })], types: groups, onChange() {} })
  const within = render(Lines, { lines: [row({ choice: 'Projector', quantity: '2' })], types: groups, onChange() {} })

  assert.match(over, /only has 2 usable/)
  assert.doesNotMatch(within, /only has/)
})

test('a type already chosen cannot be chosen again, and rows can be removed', async () => {
  const { default: Lines } = await compile('../src/components/EquipmentLinesField.jsx')

  const html = render(Lines, { lines: [row({ choice: 'Projector' }), row()], types: groups, onChange() {} })

  assert.match(html, /<option value="Projector" disabled="">Projector<\/option>/)
  assert.match(html, />Remove</)
})

test('the calendar gives each reservation its full text, and buttons only if selectable', async () => {
  const { default: Calendar } = await compile('../src/components/EquipmentMonthCalendar.jsx')
  const props = {
    title: 'Bookings',
    year: 2099,
    month: 10,
    describe: (booking) => booking.event_name,
    onChangeMonth() {},
    bookings: [{
      id: 'booking-1',
      event_name: 'Data Science Bootcamp',
      start_at: '2099-11-13T05:00:00Z',
      end_at: '2099-11-13T09:00:00Z',
    }],
  }

  const plain = render(Calendar, props)
  const selectable = render(Calendar, { ...props, onSelect() {}, selectedId: 'booking-1' })

  assert.match(plain, /title="[^"]*Data Science Bootcamp"/)
  assert.doesNotMatch(plain, /aria-pressed/)
  assert.match(selectable, /aria-pressed="true"/)
})

test('moving between months crosses the year', async () => {
  const { stepMonth } = await compile('../src/components/EquipmentMonthCalendar.jsx')

  assert.deepEqual(stepMonth({ year: 2026, month: 11 }, 1), { year: 2027, month: 0 })
  assert.deepEqual(stepMonth({ year: 2026, month: 0 }, -1), { year: 2025, month: 11 })
})

const shell = (pathname) => compile('../src/components/TechSupportShell.jsx', {
  'react-router-dom': { Link: link, useLocation: () => ({ pathname }) },
  './AppShell': { __esModule: true, default: ({ children }) => React.createElement('main', null, children) },
  './WorkspaceLayout.css': {},
})

for (const [pathname, current] of [
  ['/equipment-requests', 'Requests'],
  ['/equipment', 'Catalogue'],
  ['/equipment/new', 'Catalogue'],
  ['/equipment/item-1/bookings', 'Catalogue'],
  ['/equipment/bookings', 'Shared bookings'],
]) {
  test(`${pathname} highlights the ${current} tab`, async () => {
    const { default: Shell } = await shell(pathname)
    const html = render(Shell, { children: 'Page' })

    assert.match(html, new RegExp(`aria-current="page"[^>]*>${current}<`))
    assert.equal(html.match(/aria-current/g).length, 1)
    assert.match(html, /workspace-ui/)
    assert.match(html, /Page/)
  })
}

test('other pages highlight no tab', async () => {
  const { default: Shell } = await shell('/dashboard')
  assert.doesNotMatch(render(Shell, { children: 'Page' }), /aria-current/)
})

for (const [role, expected] of [
  ['tech_support', 'redirect:/equipment-requests'],
  ['attendee', 'redirect:/attendee/events'],
  ['coordinator', 'shared dashboard'],
]) {
  test(`${role} starts on the right page after logging in`, async () => {
    const { default: Home } = await compile('../src/components/HomeRedirect.jsx', {
      'react-router-dom': { Navigate: ({ to }) => `redirect:${to}` },
      '../context/AuthContext': { useAuth: () => ({ user: { role } }) },
      '../pages/DashboardPage': { __esModule: true, default: () => 'shared dashboard' },
    })
    assert.equal(render(Home), expected)
  })
}

const form = () => compile('../src/components/EquipmentForm.jsx')

test('the create form has one free-text type with suggestions, not a dropdown', async () => {
  const { default: Form } = await form()

  const html = render(Form, {
    catalogue: [{ name: 'Old Projector', type: 'Projector' }],
    onSubmit() {},
  })

  assert.match(html, /<input id="equipment-type"[^>]*list="equipment-types"/)
  assert.match(html, /<option value="Projector"/)
  assert.doesNotMatch(html, />Audio</)
})

test('adding an item for an Other line starts with its type filled in', async () => {
  const { default: Form } = await form()

  const html = render(Form, { initialType: 'Fog machine', onSubmit() {} })

  assert.equal(html.match(/value="Fog machine"/g).length, 2)
})

test('the create form shows why saving failed, and that it is saving', async () => {
  const { default: Form } = await form()

  const html = render(Form, { error: 'Could not save', submitting: true, onSubmit() {} })

  assert.match(html, /Could not save/)
  assert.match(html, /Saving equipment…/)
})

const window = [{ start_at: '2099-11-13T05:00:00Z', end_at: '2099-11-13T09:00:00Z' }]
const fogLine = { id: 'line-1', item_name: 'Fog machine', quantity: 2, specifics: 'Low noise' }
const smoke = { id: 'smoke', name: 'Smoke Machine', type: 'Smoke Machine', maintenance_status: 'Functional' }

const panel = () => compile('../src/components/EquipmentAllocationPanel.jsx', {
  'react-router-dom': { Link: link },
  '../api/equipmentRequests': {},
  './EquipmentMonthCalendar': { __esModule: true, default: () => 'calendar', stepMonth() {} },
})

const panelHtml = async (request, catalogue = [smoke]) => {
  const { default: Panel } = await panel()
  return render(Panel, { request, catalogue, token: 't', onChanged() {} })
}

test('a request with no valid time cannot be allocated', async () => {
  const html = await panelHtml({ id: 'r', bookings: [], lines: [fogLine] })

  assert.match(html, /nothing can be allocated/)
  assert.doesNotMatch(html, /Fog machine/)
})

test('an Other line offers the catalogue, adding the item and telling the Coordinator', async () => {
  const html = await panelHtml({ id: 'r', bookings: window, lines: [fogLine], equipment_bookings: [] })

  assert.match(html, /0\/2/)
  assert.match(html, /2 more Fog machine to allocate/)
  assert.match(html, /Low noise/)
  assert.match(html, /isn&#x27;t in the catalogue/)
  assert.match(html, /href="\/equipment\/new\?type=Fog%20machine"/)
  assert.match(html, /Notify Coordinator/)
  assert.match(html, /ID: |calendar/)
})

test('a line of a type the catalogue has does not offer those choices', async () => {
  const html = await panelHtml({
    id: 'r',
    bookings: window,
    lines: [{ id: 'line-1', item_name: 'Smoke Machine', quantity: 1 }],
    equipment_bookings: [],
  })

  assert.doesNotMatch(html, /isn&#x27;t in the catalogue/)
  assert.doesNotMatch(html, /Notify Coordinator/)
})

test('a full line says so and stops offering to add more', async () => {
  const html = await panelHtml({
    id: 'r',
    bookings: window,
    lines: [{ ...fogLine, quantity: 1 }],
    equipment_bookings: [{ id: 'b', line_id: 'line-1' }],
  })

  assert.match(html, /All Fog machine allocated/)
  assert.doesNotMatch(html, /isn&#x27;t in the catalogue/)
})

test('it opens on the first line still needing something', async () => {
  const html = await panelHtml({
    id: 'r',
    bookings: window,
    lines: [
      { id: 'line-1', item_name: 'Smoke Machine', quantity: 1 },
      { id: 'line-2', item_name: 'Fog machine', quantity: 1 },
    ],
    equipment_bookings: [{ id: 'b', line_id: 'line-1' }],
  })

  assert.match(html, /1 more Fog machine to allocate/)
})

test('a request from before lines shows no line tabs', async () => {
  const html = await panelHtml({ id: 'r', bookings: window, request_details: '2 microphones' })

  assert.doesNotMatch(html, /Requested equipment/)
})

const details = async (request, props = {}) => {
  const { RequestDetails } = await compile('../src/pages/EquipmentReviewPage.jsx', {
    'react-router-dom': { Link: link },
    '../api/equipmentRequests': {},
    '../components/TechSupportShell': { __esModule: true, default: ({ children }) => children },
    '../components/EquipmentAllocationPanel': { __esModule: true, default: () => null },
    '../context/AuthContext': { useAuth: () => ({ token: 't' }) },
  })
  return render(RequestDetails, { request, onRemove() {}, ...props })
}

const pending = 'Pending Technical Approval'

test('with nothing allocated, each line shows 0 of its quantity', async () => {
  const html = await details({
    status: pending,
    lines: [{ id: 'line-1', item_name: 'Projector', quantity: 2, specifics: 'HDMI' }],
    equipment_bookings: [],
    bookings: [],
  })

  assert.match(html, /Projector × 2/)
  assert.match(html, /HDMI/)
  assert.match(html, />0\/2</)
  assert.doesNotMatch(html, /Nothing allocated yet/)
})

test('allocated items show their real name and labelled ID under their line', async () => {
  const html = await details({
    status: pending,
    lines: [{ id: 'line-1', item_name: 'Projector', quantity: 2 }],
    equipment_bookings: [{ id: 'b', line_id: 'line-1', equipment_id: 'item-8', equipment_name: 'Old Projector' }],
    bookings: [],
  })

  assert.match(html, />1\/2</)
  assert.match(html, /Old Projector/)
  assert.match(html, /ID: item-8/)
  assert.match(html, />Remove</)
})

test('a request from before lines shows its text and any allocations', async () => {
  const empty = await details({ status: pending, request_details: '2 microphones', bookings: [] })
  const filled = await details({
    status: pending,
    request_details: '2 microphones',
    bookings: [],
    equipment_bookings: [{ id: 'b', line_id: null, equipment_id: 'mic', equipment_name: 'Microphone' }],
  })

  assert.match(empty, /2 microphones/)
  assert.match(empty, /Nothing allocated yet/)
  assert.match(filled, /ID: mic/)
})

test('a reviewed request cannot have its allocations removed from the card', async () => {
  const html = await details({
    status: 'Approved',
    lines: [{ id: 'line-1', item_name: 'Projector', quantity: 1 }],
    equipment_bookings: [{ id: 'b', line_id: 'line-1', equipment_id: 'p', equipment_name: 'Projector' }],
    bookings: [],
  })

  assert.doesNotMatch(html, />Remove</)
})

test('a removal in progress is shown', async () => {
  const html = await details({
    status: pending,
    lines: [{ id: 'line-1', item_name: 'Projector', quantity: 1 }],
    equipment_bookings: [{ id: 'b', line_id: 'line-1', equipment_id: 'p', equipment_name: 'Projector' }],
    bookings: [],
  }, { removingId: 'b' })

  assert.match(html, /Removing…/)
})

test('venue status reads normally and session-only times stay plain', async () => {
  const html = await details({
    status: pending,
    session: { name: 'Lab' },
    event: { organiser_name: 'Ada' },
    bookings: [
      { booking_id: 'v', venue_name: 'Hall', room_layout: 'Classroom', booking_status: 'PENDING_VENUE_APPROVAL',
        start_at: '2099-11-13T05:00:00Z', end_at: '2099-11-13T09:00:00Z' },
      { start_at: '2099-11-14T05:00:00Z', end_at: '2099-11-14T09:00:00Z', booking_status: 'SESSION_SCHEDULE' },
    ],
  })

  assert.match(html, /Venue booking: pending venue approval/)
  assert.doesNotMatch(html, /PENDING_VENUE_APPROVAL/)
  assert.doesNotMatch(html, /SESSION_SCHEDULE/)
  assert.match(html, /Ada/)
})

test('a rejected request shows why, and others do not', async () => {
  const rejected = await details({ status: 'Rejected', rejection_reason: 'None available', bookings: [] })
  const stale = await details({ status: pending, rejection_reason: 'None available', bookings: [] })

  assert.match(rejected, /Rejection reason/)
  assert.match(rejected, /None available/)
  assert.doesNotMatch(stale, /Rejection reason/)
})
