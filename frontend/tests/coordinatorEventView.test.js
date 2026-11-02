import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as jsxRuntime from 'react/jsx-runtime'
import { transformWithEsbuild } from 'vite'

import {
  equipmentBadge,
  isPastEquipmentRequest,
  isPastVenueRequest,
  safetyCheckChecklist,
  venueBadge,
  venueTagClass,
  visibleVenueBookings,
} from '../src/coordinatorEventView.js'

const booking = (status, session_id = 'lab') => ({ booking_id: `${status}-${session_id}`, status, session_id, venues: { name: 'Hall' } })
const lab = { id: 'lab', name: 'Lab' }
const talk = { id: 'talk', name: 'Talk', equipment_requirements: '1 projector' }

test('while planning, every venue shows, with rejected and cancelled ones last', () => {
  const bookings = [booking('REJECTED'), booking('CANCELLED'), booking('APPROVED')]
  assert.deepEqual(
    visibleVenueBookings({ status: 'planning' }, bookings).map((item) => item.status),
    ['APPROVED', 'REJECTED', 'CANCELLED'],
  )
})

test('after planning, settled venues are hidden and the rest stay', () => {
  const bookings = [
    booking('REJECTED'), booking('CANCELLED'), booking('REJECTED_BY_SAFETY'),
    booking('APPROVED'), booking('AFFECTED_BY_UNAVAILABILITY'),
  ]
  for (const status of ['awaiting_safety_check', 'confirmed', 'completed']) {
    assert.deepEqual(
      visibleVenueBookings({ status }, bookings).map((item) => item.status),
      ['APPROVED', 'AFFECTED_BY_UNAVAILABILITY'],
    )
  }
})

test('a status with a missing value is treated as still in play', () => {
  assert.equal(visibleVenueBookings({ status: 'confirmed' }, [{ booking_id: 'x' }]).length, 1)
})

test('a fully arranged event has nothing left to do', () => {
  const event = { sessions: [lab, talk] }
  assert.deepEqual(safetyCheckChecklist(
    event,
    [booking('APPROVED'), booking('APPROVED', 'talk')],
    [{ status: 'Approved', session_id: 'talk' }],
  ), [])
})

test('each session lists the venue it still needs', () => {
  assert.deepEqual(safetyCheckChecklist({ sessions: [lab] }, [booking('REJECTED')], []), ['Lab: request a venue.'])
  assert.deepEqual(
    safetyCheckChecklist({ sessions: [lab] }, [booking('PENDING_VENUE_APPROVAL')], []),
    ['Lab: waiting for its venue to be approved.'],
  )
})

test('every live booking must be approved, even beside an approved one', () => {
  assert.deepEqual(
    safetyCheckChecklist({ sessions: [lab] }, [booking('PENDING_VENUE_APPROVAL'), booking('APPROVED')], []),
    ['Hall: every booking must be approved or cancelled.'],
  )
})

test('a booking whose session was removed still needs dealing with', () => {
  assert.deepEqual(
    safetyCheckChecklist({ sessions: [lab] }, [booking('APPROVED'), booking('AFFECTED_BY_SESSION_CHANGE', null)], []),
    ['Hall: waiting for approval, or cancel it.'],
  )
  assert.deepEqual(
    safetyCheckChecklist({ sessions: [lab] }, [booking('APPROVED'), { ...booking('PENDING_VENUE_APPROVAL', 'old'), venues: null }], []),
    ['A venue: waiting for approval, or cancel it.'],
  )
})

test('equipment needed, waiting or affected is listed', () => {
  const venues = [booking('APPROVED', 'talk')]
  assert.deepEqual(safetyCheckChecklist({ sessions: [talk] }, venues, []), ['Talk: request its equipment.'])
  assert.deepEqual(
    safetyCheckChecklist({ sessions: [talk] }, venues, [{ status: 'Cancelled', session_id: 'talk' }]),
    ['Talk: request its equipment.'],
  )
  assert.deepEqual(
    safetyCheckChecklist({ sessions: [talk] }, venues, [{ status: 'Pending Technical Approval', session_id: 'talk' }]),
    ['Talk: waiting for Technical Support to review its equipment.'],
  )
  assert.deepEqual(
    safetyCheckChecklist({ sessions: [talk] }, venues, [{ status: 'Affected by Session Change', session_id: 'talk' }]),
    ['Talk: cancel its equipment request and request again.'],
  )
  assert.deepEqual(
    safetyCheckChecklist({ sessions: [lab] }, [booking('APPROVED')], [{ status: 'Pending Technical Approval', session_id: null }]),
    ['Whole event: waiting for Technical Support to review its equipment.'],
  )
})

test('a session that needs no equipment does not need a request', () => {
  assert.deepEqual(
    safetyCheckChecklist({ sessions: [{ ...lab, equipment_requirements: '  ' }] }, [booking('APPROVED')], []),
    [],
  )
})

test('an event from before sessions only needs an approved venue', () => {
  assert.deepEqual(safetyCheckChecklist({}, [], []), ['Get a venue booking approved.'])
  assert.deepEqual(safetyCheckChecklist({ sessions: [] }, [booking('APPROVED', null)], []), [])
})

test('venue tags show whether something needs attention', () => {
  assert.equal(venueTagClass('APPROVED'), 'tag tag--good')
  assert.equal(venueTagClass('PENDING_VENUE_APPROVAL'), 'tag tag--warning')
  assert.equal(venueTagClass('REJECTED'), 'tag tag--danger')
  assert.equal(venueTagClass('AFFECTED_BY_SESSION_CHANGE'), 'tag tag--danger')
  assert.equal(venueTagClass('CANCELLED'), 'tag')
})

test('the list summarises venues by what matters most', () => {
  const labels = (statuses) => venueBadge(statuses.map((status) => ({ status }))).label
  assert.equal(venueBadge(null).label, 'No Venue')
  assert.equal(labels(['CANCELLED']), 'No Venue')
  assert.equal(labels(['APPROVED', 'AFFECTED_BY_SESSION_CHANGE']), 'Venue Affected')
  assert.equal(labels(['APPROVED', 'AFFECTED_BY_UNAVAILABILITY']), 'Venue Affected')
  assert.equal(labels(['APPROVED', 'REJECTED']), 'Venue Approved')
  assert.equal(labels(['PENDING_VENUE_APPROVAL', 'REJECTED']), 'Venue Pending')
  assert.equal(labels(['REJECTED']), 'Venue Rejected')
})

test('the list summarises equipment by what matters most', () => {
  const label = (statuses) => equipmentBadge(statuses.map((status) => ({ status })))?.label
  assert.equal(equipmentBadge(null), null)
  assert.equal(label(['Cancelled']), undefined)
  assert.equal(label(['Approved', 'Affected by Session Change']), 'Equipment Affected')
  assert.equal(label(['Approved', 'Approved']), 'Equipment Approved')
  assert.equal(label(['Approved', 'Rejected']), 'Equipment Rejected')
  assert.equal(label(['Rejected', 'Pending Technical Approval']), 'Equipment Pending')
})

test('venue requests are past once settled or their event has ended', () => {
  const planning = { status: 'planning' }
  assert.equal(isPastVenueRequest(booking('PENDING_VENUE_APPROVAL'), planning), false)
  assert.equal(isPastVenueRequest(booking('APPROVED'), { status: 'confirmed' }), false)
  assert.equal(isPastVenueRequest(booking('AFFECTED_BY_SESSION_CHANGE'), planning), false)
  assert.equal(isPastVenueRequest(booking('REJECTED'), planning), true)
  assert.equal(isPastVenueRequest(booking('CANCELLED'), planning), true)
  assert.equal(isPastVenueRequest(booking('REJECTED_BY_SAFETY'), planning), true)
  for (const status of ['completed', 'rejected', 'cancelled']) {
    assert.equal(isPastVenueRequest(booking('APPROVED'), { status }), true)
  }
})

test('equipment requests are past once closed or their event has ended', () => {
  const request = (status) => ({ status })
  const planning = { status: 'planning' }
  assert.equal(isPastEquipmentRequest(request('Pending Technical Approval'), planning), false)
  assert.equal(isPastEquipmentRequest(request('Approved'), planning), false)
  assert.equal(isPastEquipmentRequest(request('Affected by Session Change'), planning), false)
  assert.equal(isPastEquipmentRequest(request('Rejected'), planning), true)
  assert.equal(isPastEquipmentRequest(request('Cancelled'), planning), true)
  assert.equal(isPastEquipmentRequest(request('Approved'), { status: 'completed' }), true)
  assert.equal(isPastEquipmentRequest(request('Approved'), undefined), false)
})

const link = ({ to, children, ...props }) => React.createElement('a', { ...props, href: to }, children)

async function compile(path, imports) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  const { code } = await transformWithEsbuild(source, path, { format: 'cjs', jsx: 'automatic', tsconfigRaw: '{}' })
  const module = { exports: {} }
  const dependencies = { react: React, 'react/jsx-runtime': jsxRuntime, ...imports }
  new Function('require', 'module', 'exports', code)((name) => {
    assert.ok(name in dependencies, `unexpected dependency: ${name}`)
    return dependencies[name]
  }, module, module.exports)
  return module.exports.default
}

const tabsAt = (pathname) => compile('../src/components/CoordinatorTabs.jsx', {
  'react-router-dom': { Link: link, useLocation: () => ({ pathname }) },
})

for (const [pathname, current] of [
  ['/dashboard', 'Events'],
  ['/event-reviews/event-1', 'Events'],
  ['/equipment-requests', 'Equipment requests'],
  ['/venue-requests', 'Venue requests'],
  ['/venues/search', 'Venue requests'],
  ['/venues/availability', 'Venue requests'],
]) {
  test(`${pathname} highlights the ${current} tab`, async () => {
    const html = renderToStaticMarkup(React.createElement(await tabsAt(pathname)))
    assert.match(html, new RegExp(`aria-current="page"[^>]*>${current}<`))
    assert.equal(html.match(/aria-current/g).length, 1)
  })
}

test('requesting starts from an event, so no tab offers it directly', async () => {
  const html = renderToStaticMarkup(React.createElement(await tabsAt('/dashboard')))
  assert.doesNotMatch(html, /href="\/venues/)
  assert.equal(html.match(/<a /g).length, 3)
})

test('other pages highlight no tab', async () => {
  const html = renderToStaticMarkup(React.createElement(await tabsAt('/profile')))
  assert.doesNotMatch(html, /aria-current/)
})

for (const [role, themed] of [
  ['coordinator', true],
  ['venue_staff', false],
  ['organiser', false],
  ['event_coordinator_lead', false],
  ['safety_officer', false],
]) {
  test(`${role} ${themed ? 'gets' : 'keeps'} ${themed ? 'the new workspace' : 'the current look'}`, async () => {
    const Shell = await compile('../src/components/AppShell.jsx', {
      'react-router-dom': { Link: link, useNavigate: () => () => {} },
      '../context/AuthContext': { useAuth: () => ({ user: { role, full_name: 'User' }, logout() {} }) },
      './CoordinatorTabs': { __esModule: true, default: () => 'TABS' },
      './NotificationDropdown': { __esModule: true, default: () => null },
      './WorkspaceLayout.css': {},
    })
    const html = renderToStaticMarkup(React.createElement(Shell, null, 'Page'))

    assert.equal(html.includes('workspace-ui'), themed)
    assert.equal(html.includes('TABS'), themed)
    assert.match(html, /Page/)
  })
}
