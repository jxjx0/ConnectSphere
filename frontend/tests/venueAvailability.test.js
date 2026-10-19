import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { transformWithEsbuild } from 'vite'
import * as jsxRuntime from 'react/jsx-runtime'
import * as helpers from '../src/venueAvailability.js'
import * as display from '../src/eventDisplay.js'
import * as searchHelpers from '../src/venueSearch.js'

const date = '2026-11-20'
const week = helpers.calendarWeek(date)
const venues = [{ id: 'hall', name: 'Grand Hall' }, { id: 'room', name: 'Room Two' }]
const data = (id = 'hall', range = week.range, items = []) => ({
  venue: { id, name: 'Grand Hall' }, ...range, verification_status: 'partial',
  sources: { operational_blocks: 'verified', confirmed_bookings: 'unavailable' }, items,
})
const block = { id: 'block', type: 'operational_block', start_at: new Date('2026-11-20T10:00').toISOString(),
  end_at: new Date('2026-11-20T12:00').toISOString(), reason: 'Maintenance' }

test('week begins Monday and navigation changes local calendar dates', () => {
  assert.equal(week.days[0].date, '2026-11-16')
  assert.equal(week.days[6].date, '2026-11-22')
  assert.equal(helpers.shiftCalendarDate(date, 7), '2026-11-27')
  assert.equal(helpers.shiftCalendarDate(date, -7), '2026-11-13')
  assert.throws(() => helpers.calendarWeek('2026-02-30'))
  assert.throws(() => helpers.calendarWeek(''))
})

test('local week ranges use Singapore UTC conversion and DST calendar arithmetic', () => {
  const helper = new URL('../src/venueAvailability.js', import.meta.url).href
  for (const [tz, code] of [
    ['Asia/Singapore', `assert.deepEqual(calendarWeek('2026-11-20').range, { start_at: '2026-11-15T16:00:00.000Z', end_at: '2026-11-22T16:00:00.000Z' })`],
    ['America/New_York', `const days = calendarWeek('2026-03-08').days; assert.equal((days[6].end - days[6].start) / 3600000, 23); assert.equal(days[6].date, '2026-03-08')`],
  ]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict'; import { calendarWeek } from ${JSON.stringify(helper)}; ${code}`],
      { env: { ...process.env, TZ: tz }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
})

test('day grouping preserves full overnight/multidate intervals and excludes touching boundaries', () => {
  const item = { ...block, start_at: new Date('2026-11-19T22:00').toISOString(), end_at: new Date('2026-11-21T00:00').toISOString() }
  assert.equal(helpers.blocksForDay([item], week.days[3]).length, 1)
  assert.equal(helpers.blocksForDay([item], week.days[4]).length, 1)
  assert.equal(helpers.blocksForDay([item], week.days[5]).length, 0)
  assert.equal(item.end_at, new Date('2026-11-21T00:00').toISOString())
})

test('malformed or mismatched responses cannot become empty calendar results', () => {
  assert.equal(helpers.validateCalendarResponse(data(), 'hall', week.range).items.length, 0)
  for (const invalid of [null, data('wrong'), { ...data(), items: null }, { ...data(), sources: {} },
    { ...data(), start_at: 'bad' }, { ...data(), items: [{ ...block, end_at: block.start_at }] },
    { ...data(), items: [{ ...block, reason: '' }] }]) {
    assert.throws(() => helpers.validateCalendarResponse(invalid, 'hall', week.range))
  }
})

test('operating-hour shading respects Singapore time in each browser timezone', () => {
  const helper = new URL('../src/venueAvailability.js', import.meta.url).href
  for (const [tz, open, close, expected] of [
    ['Asia/Singapore', '08:30', '22:15', [[0, 8.5], [22.25, 1.75]]],
    ['UTC', '08:00', '22:00', [[14, 10]]],
    ['America/New_York', '08:00', '22:00', [[9, 10]]],
  ]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { calendarWeek, calendarOperatingHours } from ${JSON.stringify(helper)};
      const day = calendarWeek('2026-11-20').days[4];
      const result = calendarOperatingHours({open:${JSON.stringify(open)},close:${JSON.stringify(close)}}, day);
      const expected = ${JSON.stringify(expected)};
      assert.equal(result.closed.length, expected.length);
      result.closed.forEach((segment,index) => {
        assert.ok(Math.abs(segment.top - expected[index][0] / 24 * 100) < 0.00001);
        assert.ok(Math.abs(segment.height - expected[index][1] / 24 * 100) < 0.00001);
      });
    `], { env: { ...process.env, TZ: tz }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
})

test('missing or invalid operating hours do not invent closed periods', () => {
  for (const value of [undefined, null, {}, { open: 'bad', close: '22:00' },
    { open: '08:00', close: '08:00' }, { open: '22:00', close: '08:00' }]) {
    assert.equal(helpers.calendarOperatingHours(value, week.days[0]), null)
  }
})

const source = await readFile(new URL('../src/pages/VenueAvailabilityPage.jsx', import.meta.url), 'utf8')
const { code } = await transformWithEsbuild(source, 'VenueAvailabilityPage.jsx', { jsx: 'automatic', format: 'cjs', tsconfigRaw: '{}' })

function harness({ get = async (id, range) => data(id, range), catalogue = async () => ({ venues }), initial = {}, role = 'coordinator', query = '', fresh = false,
  getEvent = async (id) => ({ event: { id, name: 'Planning workshop' } }) } = {}) {
  let index = 0
  const effects = []
  const states = [initial.catalogue || { loading: false, error: '', venues }, 'hall', date, 0,
    { key: `hall/${week.range.start_at}/${week.range.end_at}/0`, loading: false, error: '', data: data() }, null, null, false, 0, null, { id: '', event: null, error: '' }]
  if (fresh) states.length = 0
  const BlockForm = () => null
  const module = { exports: {} }
  const imports = {
    react: { ...React, useState: (value) => {
      const current = index++
      if (!(current in states)) states[current] = typeof value === 'function' ? value() : value
      return [states[current], (value) => { states[current] = typeof value === 'function' ? value(states[current]) : value }]
    }, useEffect: (effect) => effects.push(effect) },
    'react/jsx-runtime': jsxRuntime,
    'react-router-dom': { Link: ({ to, children, ...props }) => React.createElement('a', { ...props, href: to }, children), useSearchParams: () => [new URLSearchParams(query)] },
    '../api/venues': { getVenues: catalogue, getVenueAvailability: get },
    '../api/events': { getAssignedEventRequest: getEvent },
    '../components/AppShell': { __esModule: true, default: ({ children }) => React.createElement('main', null, children) },
    '../components/BlockForm': { __esModule: true, default: BlockForm },
    '../context/AuthContext': { useAuth: () => ({ token: 'token', user: { role } }) },
    '../eventDisplay': display,
    '../venueSearch.js': searchHelpers,
    '../venueAvailability': helpers,
    '../components/BookingForm.jsx': { __esModule: true, default: () => null },
  }
  new Function('require', 'module', 'exports', code)((name) => {
    assert.ok(name in imports, `unexpected import ${name}`)
    return imports[name]
  }, module, module.exports)
  function tree() { index = 0; effects.length = 0; return module.exports.default() }
  return { states, tree, BlockForm, html: () => { index = 0; return renderToStaticMarkup(React.createElement(module.exports.default)) },
    runEffect: (which) => { tree(); return effects[which]() } }
}

function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean)
  if (!React.isValidElement(node)) return undefined
  return predicate(node) ? node : find(node.props.children, predicate)
}
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('calendar separates holds, bookings and blocks and shows hold expiry', () => {
  const page = harness({ role: 'venue_staff' })
  const hold = { ...block, id: 'hold', type: 'tentative_hold', reason: 'Tentative hold', expires_at: '2099-11-06T04:00Z' }
  const booking = { ...block, id: 'booking', type: 'confirmed_booking', reason: 'Confirmed booking' }
  page.states[4].data = data('hall', week.range, [block, hold, booking])
  assert.match(page.html(), /venue-calendar__time-block--tentative_hold/)
  assert.match(page.html(), /venue-calendar__time-block--confirmed_booking/)
  find(page.tree(), node => node.props['aria-label']?.startsWith('Tentative hold:')).props.onClick()
  assert.match(page.html(), /Expires:/)
  const button = find(page.tree(), node => node.type === 'button' && node.props.children === 'Block / Tentative Hold')
  button.props.onClick()
  const modal = find(page.tree(), node => node.type === page.BlockForm)
  assert.equal(modal.props.venue.id, 'hall')
  modal.props.onCreated()
  assert.equal(page.states[3], 1)
  const coordinator = harness()
  assert.equal(find(coordinator.tree(), node => node.props.children === 'Block / Tentative Hold'), undefined)
})

test('calendar filters expired holds at the exact boundary and rejects unverified hold sources', () => {
  const response = { ...data(), verification_status: 'verified',
    sources: { operational_blocks: 'verified', confirmed_bookings: 'verified', tentative_holds: 'verified', hold_expiry: 'verified', venue_buffers: 'verified' },
    items: [{ ...block, type: 'tentative_hold', expires_at: new Date().toISOString() }] }
  assert.deepEqual(helpers.validateCalendarResponse(response, 'hall', week.range).items, [])
  assert.throws(() => helpers.validateCalendarResponse({ ...response, sources: { ...response.sources, tentative_holds: 'unavailable' } }, 'hall', week.range))
})

test('calendar schedules a refresh when its next hold expires', t => {
  const schedule = t.mock.method(globalThis, 'setTimeout', () => 'hold-timer')
  const cancel = t.mock.method(globalThis, 'clearTimeout', () => {})
  const page = harness()
  page.states[4].data = data('hall', week.range, [{ ...block, type: 'tentative_hold', expires_at: new Date(Date.now() + 5000).toISOString() }])
  const cleanup = page.runEffect(3)
  const [refresh, delay] = schedule.mock.calls[0].arguments
  assert.ok(delay > 0 && delay <= 5050)
  refresh()
  assert.equal(page.states[3], 1)
  cleanup()
  assert.equal(cancel.mock.calls[0].arguments[0], 'hold-timer')
})

test('selected venue shows its hours and labelled closed shading without hiding blocks', () => {
  const page = harness()
  page.states[0] = { loading: false, error: '', venues: [
    { ...venues[0], operating_hours: { open: '08:00', close: '22:00' } },
    { ...venues[1], operating_hours: { open: '10:00', close: '18:00' } },
  ] }
  const outsideHours = { ...block, start_at: new Date('2026-11-20T00:00').toISOString(),
    end_at: new Date('2026-11-21T00:00').toISOString(), reason: 'All-day maintenance' }
  page.states[4].data = data('hall', week.range, [outsideHours])
  const html = page.html()
  assert.match(html, /Operating hours: 08:00–22:00 \(Singapore time\)/)
  assert.match(html, /venue-calendar__closed/)
  assert.match(html, /aria-label="Closed:/)
  assert.match(html, /Local time/)
  assert.match(html, /Operational block: All-day maintenance/)
  assert.ok(find(page.tree(), node => node.type === 'button' && node.props.title?.includes('All-day maintenance')))
  page.states[1] = 'room'
  assert.match(page.html(), /Operating hours: 10:00–18:00/)
  page.states[0].venues[1].operating_hours = null
  assert.match(page.html(), /Operating hours unavailable/)
  assert.doesNotMatch(page.html(), /venue-calendar__closed/)
})

test('calendar deep links select the requested venue/week and return to the source page', async () => {
  const page = harness({ fresh: true, role: 'venue_staff', query: 'venueId=room&date=2026-11-27&from=catalogue' })
  page.runEffect(0); await settle()
  assert.equal(page.states[1], 'room')
  assert.equal(page.states[2], '2026-11-27')
  assert.match(page.html(), /href="\/venues".*Back to Venue Catalogue/)
  const search = 'eventId=event-1&filters=1&expected_attendance=120'
  const coordinator = harness({ query: new URLSearchParams({ from: 'search', search }).toString() })
  const back = find(coordinator.tree(), (node) => node.props.className === 'venue-search__back')
  assert.equal(back.props.to, `/venues/search?${search}&resume=1`)
  const missing = harness({ fresh: true, query: 'venueId=missing' })
  missing.runEffect(0); await settle()
  assert.equal(missing.states[1], '')
  assert.match(missing.html(), /Select a venue/)
})

test('coordinator calendar keeps authorised event context and the requested period visible', async () => {
  const search = 'eventId=event-1&filters=1&date=2026-11-20&start_time=10%3A00&end_time=12%3A00'
  const query = new URLSearchParams({ from: 'search', search }).toString()
  const page = harness({ query })
  page.runEffect(2); await settle()
  assert.match(page.html(), /Finding a venue for:.*Planning workshop/)
  assert.match(page.html(), /Requested period:/)
  assert.match(page.html(), /Return to matching venues/)
  assert.doesNotMatch(page.html(), /Loading event context/)
  const failed = harness({ query, getEvent: async () => { throw new Error('Private details') } })
  failed.runEffect(2); await settle()
  assert.match(failed.html(), /Event context could not be loaded/)
  assert.doesNotMatch(failed.html(), /Private details|Planning workshop/)
  assert.match(failed.html(), /Return to matching venues/)
})

test('staff calendar reuses blocking and refreshes only after creation; coordinator has no block action', () => {
  const page = harness({ role: 'venue_staff' })
  const action = find(page.tree(), (node) => node.type === 'button' && node.props.children === 'Block / Tentative Hold')
  assert.equal(action.props.disabled, false)
  action.props.onClick()
  const popup = find(page.tree(), (node) => node.type === page.BlockForm)
  assert.equal(popup.props.venue.id, 'hall')
  popup.props.onClose()
  assert.equal(page.states[3], 0)
  assert.equal(page.states[9], null)
  action.props.onClick()
  find(page.tree(), (node) => node.type === page.BlockForm).props.onCreated()
  assert.equal(page.states[3], 1)
  assert.doesNotMatch(page.html(), /No recorded occupancy/)
  page.states[1] = ''
  assert.equal(find(page.tree(), (node) => node.type === 'button' && node.props.children === 'Block / Tentative Hold').props.disabled, true)
  assert.equal(find(harness().tree(), (node) => node.type === 'button' && node.props.children === 'Block / Tentative Hold'), undefined)
})

test('venue options sort alphabetically and search name/location without mutating the catalogue', () => {
  const catalogue = [{ id: 'z', name: 'Zulu Hall', location: 'East Campus' },
    { id: 'b', name: 'beta Room', location: null }, { id: 'a', name: 'Alpha Hall', location: 'West Campus' }]
  assert.deepEqual(helpers.calendarVenueOptions(catalogue).map((venue) => venue.id), ['a', 'b', 'z'])
  assert.deepEqual(helpers.calendarVenueOptions(catalogue, '  HALL ').map((venue) => venue.id), ['a', 'z'])
  assert.deepEqual(helpers.calendarVenueOptions(catalogue, 'east').map((venue) => venue.id), ['z'])
  assert.deepEqual(helpers.calendarVenueOptions(catalogue, 'missing'), [])
  assert.deepEqual(helpers.calendarVenueOptions(catalogue, 'east', 'a').map((venue) => venue.id), ['a', 'z'])
  assert.deepEqual(catalogue.map((venue) => venue.id), ['z', 'b', 'a'])
})

test('venue dropdown opens a searchable list and selection changes only after choosing an option', () => {
  const page = harness()
  page.states[0].venues = [...venues, { id: 'other', name: 'Other Hall', location: 'North' }]
  const trigger = find(page.tree(), (node) => node.props.id === 'calendar-venue')
  assert.equal(trigger.type, 'button')
  assert.equal(trigger.props['aria-expanded'], false)
  trigger.props.onClick({})
  const search = find(page.tree(), (node) => node.props.role === 'combobox')
  assert.ok(search.props.autoFocus)
  search.props.onChange({ target: { value: 'TWO' } })
  assert.equal(page.states[1], 'hall')
  assert.match(page.html(), /Room Two/)
  assert.doesNotMatch(page.html(), /Other Hall/)
  assert.match(page.html(), /No recorded occupancy/)
  find(page.tree(), (node) => node.props.role === 'option').props.onClick({})
  assert.equal(page.states[1], 'room')
  assert.equal(page.states[7], false)
  trigger.props.onClick({})
  const newSearch = find(page.tree(), (node) => node.props.role === 'combobox')
  newSearch.props.onChange({ target: { value: 'nothing matches' } })
  assert.match(page.html(), /No venues match your search/)
  assert.equal(page.states[1], 'room')
  newSearch.props.onChange({ target: { value: '' } })
  assert.match(page.html(), /Other Hall/)
  assert.match(page.html(), /for="calendar-venue"/)
  assert.match(page.html(), /for="calendar-week"/)
  newSearch.props.onChange({ target: { value: 'north' } })
  assert.match(page.html(), /North/)
  find(page.tree(), (node) => node.props.role === 'option').props.onClick({})
  assert.equal(page.states[1], 'other')
  assert.equal(find(page.tree(), (node) => node.type === 'select'), undefined)
})

test('searchable dropdown supports arrows, Enter, Escape, blur dismissal and focus restoration', () => {
  const page = harness()
  const trigger = find(page.tree(), (node) => node.props.id === 'calendar-venue')
  trigger.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} })
  let search = find(page.tree(), (node) => node.props.role === 'combobox')
  search.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} })
  assert.equal(page.states[8], 1)
  let focused = 0
  const currentTarget = { closest: () => ({ querySelector: () => ({ focus: () => focused++ }) }) }
  find(page.tree(), (node) => node.props.role === 'combobox').props.onKeyDown({ key: 'Enter', preventDefault() {}, currentTarget })
  assert.equal(page.states[1], 'room')
  assert.equal(focused, 1)
  trigger.props.onClick({})
  search = find(page.tree(), (node) => node.props.role === 'combobox')
  search.props.onKeyDown({ key: 'ArrowUp', preventDefault() {} })
  assert.equal(page.states[8], 0)
  search.props.onKeyDown({ key: 'Escape', preventDefault() {}, currentTarget })
  assert.equal(page.states[7], false)
  assert.equal(page.states[1], 'room')
  trigger.props.onClick({})
  find(page.tree(), (node) => node.props.className === 'field venue-picker').props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null })
  assert.equal(page.states[7], false)
})

test('catalogue loading leaves selection empty and refresh preserves an existing selection', async () => {
  const page = harness({ catalogue: async () => ({ venues: [{ id: 'z', name: 'Zulu' }, { id: 'a', name: 'Alpha' }] }) })
  page.states[1] = ''
  page.runEffect(0); await settle()
  assert.equal(page.states[1], '')
  assert.deepEqual(page.states[0].venues.map((venue) => venue.id), ['a', 'z'])
  page.states[1] = 'z'
  page.runEffect(0); await settle()
  assert.equal(page.states[1], 'z')
  page.states[1] = 'removed'
  page.runEffect(0); await settle()
  assert.equal(page.states[1], '')
})

test('page shows seven days, a compact legend, empty wording and dashboard navigation', () => {
  const html = harness().html()
  assert.match(html, /Venue Availability/)
  assert.match(html, /aria-label="Calendar legend"/)
  assert.match(html, /Recorded block/)
  assert.doesNotMatch(html, /partially verified|not fully verified|Additional reservations|Empty grid space/i)
  assert.equal((html.match(/No recorded occupancy/g) || []).length, 7)
  assert.match(html, /href="\/dashboard"/)
  assert.doesNotMatch(html, />Available</)
})

test('calendar prominently identifies the selected venue, location and visible week', () => {
  const page = harness()
  page.states[0].venues = [{ id: 'hall', name: 'Grand Hall', location: 'West Campus' }]
  assert.match(page.html(), /<h2>Grand Hall<\/h2>/)
  assert.match(page.html(), /West Campus/)
  assert.match(page.html(), /16 Nov 2026 – 22 Nov 2026/)
  page.states[2] = '2026-11-27'
  assert.match(page.html(), /23 Nov 2026 – 29 Nov 2026/)
})

test('block reason and full local range display on every affected day without exposing identifiers', () => {
  const page = harness()
  const overnight = { ...block, start_at: new Date('2026-11-19T22:00').toISOString(), end_at: new Date('2026-11-21T02:00').toISOString() }
  page.states[4].data = data('hall', week.range, [overnight])
  const html = renderToStaticMarkup(find(page.tree(), (node) => node.props.className === 'venue-calendar__week'))
  assert.equal((html.match(/Operational block/g) || []).length, 3)
  assert.equal((html.match(/Maintenance/g) || []).length, 3)
  assert.ok(html.includes(display.formatDateRange(overnight.start_at, overnight.end_at)))
  assert.equal((html.match(/Continues from previous day/g) || []).length, 2)
  assert.equal((html.match(/Continues into next day/g) || []).length, 2)
  assert.doesNotMatch(html, /dateTime="2026-11-19T|block_id|>hall</)
})

test('time grid positions blocks precisely, clips overnight segments and separates overlaps', () => {
  const friday = week.days[4]
  const positioned = helpers.calendarBlockPositions([block], friday)[0]
  assert.equal(positioned.top, 10 / 24 * 100)
  assert.equal(positioned.height, 2 / 24 * 100)
  assert.equal(positioned.width, 100)
  const overlapping = helpers.calendarBlockPositions([block, { ...block, id: 'second' }], friday)
  assert.deepEqual(overlapping.map((item) => item.left), [0, 50])
  assert.deepEqual(overlapping.map((item) => item.width), [50, 50])
  const overnight = { ...block, start_at: new Date('2026-11-19T22:00').toISOString(), end_at: new Date('2026-11-20T02:00').toISOString() }
  const segment = helpers.calendarBlockPositions([overnight], friday)[0]
  assert.equal(segment.top, 0)
  assert.equal(segment.height, 2 / 24 * 100)
  assert.equal(segment.item.start_at, overnight.start_at)
  assert.deepEqual(helpers.calendarBlockPositions([], friday), [])
})

test('weekly time grid has day headers, hour labels and keyboard-accessible block details', () => {
  const page = harness()
  page.states[4].data = data('hall', week.range, [block])
  const html = page.html()
  assert.match(html, /Weekly time grid/)
  assert.match(html, /12 AM/)
  assert.match(html, /11 PM/)
  const gridLines = html.match(/class="venue-calendar__hour-lines" aria-hidden="true">(.*?)<\/div>/g) || []
  assert.equal(gridLines.length, 7)
  for (const dayLines of gridLines) assert.equal((dayLines.match(/<span><\/span>/g) || []).length, 24)
  assert.match(html, /aria-label="Operational block: Maintenance/)
  assert.match(html, /<summary>View daily block details<\/summary>/)
  assert.match(html, /Recorded block/)
  assert.doesNotMatch(html, /Empty grid space is not verified availability/)
})

test('short grid blocks preserve their timing without clipped labels and still open full details', () => {
  const page = harness()
  const short = { ...block, start_at: new Date('2026-11-20T19:45').toISOString(), end_at: new Date('2026-11-20T20:00').toISOString() }
  page.states[4].data = data('hall', week.range, [short])
  const button = find(page.tree(), (node) => node.props.className?.includes('venue-calendar__time-block--compact'))
  assert.ok(button)
  assert.equal(button.props.style.top, `${19.75 / 24 * 100}%`)
  assert.equal(button.props.style.height, `${15 / 1440 * 100}%`)
  assert.equal(find(button, (node) => node.type === 'strong'), undefined)
  assert.match(button.props['aria-label'], /Maintenance/)
  assert.ok(button.props.title.includes(display.formatDateRange(short.start_at, short.end_at)))
  button.props.onClick()
  const details = find(page.tree(), (node) => node.props.id === 'calendar-block-details')
  assert.match(renderToStaticMarkup(details), /Maintenance/)
  assert.ok(renderToStaticMarkup(details).includes(display.formatDateRange(short.start_at, short.end_at)))
  page.states[4].data = data('hall', week.range, [block])
  assert.ok(find(page.tree(), (node) => node.props.className === 'venue-calendar__time-block'))
})

test('block selection shows details outside the grid and closes or hides them on context changes', () => {
  const page = harness()
  page.states[4].data = data('hall', week.range, [block])
  const button = find(page.tree(), (node) => node.type === 'button' && node.props.className === 'venue-calendar__time-block')
  assert.equal(button.props['aria-expanded'], false)
  button.props.onClick()
  let tree = page.tree()
  const grid = find(tree, (node) => node.props.className === 'venue-calendar__scroll')
  assert.equal(find(grid, (node) => node.props.id === 'calendar-block-details'), undefined)
  const panel = find(tree, (node) => node.props.id === 'calendar-block-details')
  assert.ok(panel)
  assert.match(renderToStaticMarkup(panel), /Grand Hall/)
  assert.match(renderToStaticMarkup(panel), /Maintenance/)
  assert.equal(find(tree, (node) => node.props.className === 'venue-calendar__time-block').props['aria-expanded'], true)
  find(tree, (node) => node.type === 'button' && node.props.children === 'Close details').props.onClick()
  assert.doesNotMatch(page.html(), /id="calendar-block-details"/)
  button.props.onClick()
  page.states[2] = '2026-11-27'
  assert.doesNotMatch(page.html(), /id="calendar-block-details"/)
})

test('venue/date selectors and week/refresh buttons update the request inputs', async () => {
  const calls = []
  const page = harness({ get: async (...args) => { calls.push(args); return data(args[0], args[1]) } })
  find(page.tree(), (node) => node.props.id === 'calendar-venue').props.onClick({})
  find(page.tree(), (node) => node.props.role === 'option' && node.props['aria-selected'] === false).props.onClick({})
  find(page.tree(), (node) => node.type === 'input' && node.props.type === 'date').props.onChange({ target: { value: '2026-11-27' } })
  page.runEffect(1)
  await settle()
  assert.deepEqual(calls[0], ['room', helpers.calendarWeek('2026-11-27').range, 'token'])
  find(page.tree(), (node) => node.type === 'button' && node.props.children === 'Previous week').props.onClick()
  assert.equal(page.states[2], date)
  find(page.tree(), (node) => node.type === 'button' && node.props.children === 'Next week').props.onClick()
  assert.equal(page.states[2], '2026-11-27')
  find(page.tree(), (node) => node.type === 'button' && node.props.children === 'This week').props.onClick()
  assert.equal(page.states[2], helpers.localDateValue())
  find(page.tree(), (node) => node.type === 'button' && node.props.children === 'Refresh').props.onClick()
  assert.equal(page.states[3], 1)
})

test('loading and request errors hide old occupancy and preserve retry controls', async () => {
  const page = harness({ get: async () => { throw new Error('Network error') } })
  page.states[4].data = data('hall', week.range, [block])
  page.runEffect(1)
  assert.match(page.html(), /Loading venue occupancy/)
  assert.doesNotMatch(page.html(), /Maintenance/)
  await settle()
  assert.match(page.html(), /role="alert"/)
  assert.match(page.html(), /Network error/)
  assert.doesNotMatch(page.html(), /No recorded occupancy|Maintenance/)
  assert.match(page.html(), /Refresh/)
})

test('cancelled old selection response cannot overwrite the newer venue', async () => {
  let resolveOld
  const page = harness({ get: (id, range) => id === 'hall' ? new Promise((resolve) => { resolveOld = resolve }) : Promise.resolve(data(id, range)) })
  const cleanup = page.runEffect(1)
  page.states[1] = 'room'
  assert.doesNotMatch(page.html(), /No recorded occupancy/)
  cleanup()
  page.runEffect(1)
  await settle()
  resolveOld(data())
  await settle()
  assert.equal(page.states[4].data.venue.id, 'room')
})

test('initial catalogue load waits for a venue choice before requesting or showing occupancy', async () => {
  const calls = []
  const page = harness({ get: async (...args) => { calls.push(args); return data(args[0], args[1]) } })
  page.states[1] = ''
  page.runEffect(0)
  assert.match(page.html(), /Loading venues/)
  await settle()
  assert.equal(page.states[1], '')
  assert.match(page.html(), /Select a venue/)
  assert.doesNotMatch(page.html(), /No recorded occupancy|Loading venue occupancy|Availability not fully verified|Weekly time grid/)
  page.runEffect(1); await settle()
  assert.equal(calls.length, 0)
  find(page.tree(), (node) => node.props.id === 'calendar-venue').props.onClick({})
  find(page.tree(), (node) => node.props.role === 'option').props.onClick({})
  page.runEffect(1); await settle()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'hall')
  assert.match(page.html(), /Weekly time grid/)
})

test('empty and failed catalogue loads do not show occupancy', async () => {
  const empty = harness({ catalogue: async () => ({ venues: [] }) })
  empty.runEffect(0); await settle()
  assert.match(empty.html(), /No venues to display/)
  assert.doesNotMatch(empty.html(), /No recorded occupancy/)
  const failed = harness({ catalogue: async () => { throw new Error('Catalogue failed') } })
  failed.runEffect(0); await settle()
  assert.match(failed.html(), /Catalogue failed/)
  assert.doesNotMatch(failed.html(), /No recorded occupancy/)
})

test('availability API wrapper encodes timezone offsets and uses bearer authentication', async () => {
  const apiSource = await readFile(new URL('../src/api/venues.js', import.meta.url), 'utf8')
  const apiCode = await transformWithEsbuild(apiSource, 'venues.js', { format: 'cjs', define: { 'import.meta.env': '{}' } })
  const module = { exports: {} }
  let call
  new Function('module', 'exports', 'fetch', apiCode.code)(module, module.exports,
    async (...args) => { call = args; return { ok: true, json: async () => data() } })
  await module.exports.getVenueAvailability('hall', { start_at: '2026-11-20T10:00:00+08:00', end_at: '2026-11-20T12:00:00+08:00' }, 'token')
  const url = new URL(call[0])
  assert.equal(url.pathname, '/venues/hall/availability')
  assert.equal(url.searchParams.get('start_at'), '2026-11-20T10:00:00+08:00')
  assert.equal(call[1].headers.Authorization, 'Bearer token')
  assert.equal(call[1].method, 'GET')
})

test('calendar route and dashboard expose venue tasks only to the established roles', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
  assert.match(app, /path="\/venues\/availability"[\s\S]*?allowedRoles=\{\['venue_staff', 'coordinator'\]\}/)
  const dashboard = await readFile(new URL('../src/pages/DashboardPage.jsx', import.meta.url), 'utf8')
  const dashboardCode = await transformWithEsbuild(dashboard, 'DashboardPage.jsx', { jsx: 'automatic', format: 'cjs', tsconfigRaw: '{}' })
  for (const role of ['venue_staff', 'coordinator', 'tech_support', 'organiser', 'attendee']) {
    let index = 0
    const states = [[], '', false]
    const module = { exports: {} }
    const imports = {
      react: { ...React, useEffect: () => {}, useState: () => [states[index++], () => {}] },
      'react/jsx-runtime': jsxRuntime,
      'react-router-dom': { Link: ({ to, children, ...props }) => React.createElement('a', { ...props, href: to }, children) },
      '../api/events': {},
      '../components/AppShell': { __esModule: true, default: 'main' },
      '../components/AssignedRequestTabs': { __esModule: true, default: () => null },
      '../context/AuthContext': { useAuth: () => ({ user: { role, full_name: 'User' }, token: 'token' }) },
    }
    new Function('require', 'module', 'exports', dashboardCode.code)((name) => imports[name], module, module.exports)
    const html = renderToStaticMarkup(React.createElement(module.exports.default))
    assert.equal(html.includes('href="/venues/availability"'), role === 'venue_staff')
    assert.equal(html.includes('href="/venues/search"'), role === 'coordinator')
    assert.equal(html.includes('View Venue Catalogue'), role === 'venue_staff')
    assert.doesNotMatch(html, /arrive in the next/)
  }
  const guardSource = await readFile(new URL('../src/components/AuthGuard.jsx', import.meta.url), 'utf8')
  const transformed = await transformWithEsbuild(guardSource, 'AuthGuard.jsx', { jsx: 'automatic', format: 'cjs', tsconfigRaw: '{}' })
  for (const role of ['venue_staff', 'coordinator', 'tech_support', 'organiser', 'attendee']) {
    const module = { exports: {} }
    const imports = { react: React, 'react/jsx-runtime': jsxRuntime, 'react-router-dom': {},
      '../context/AuthContext': { useAuth: () => ({ user: { role }, loading: false }) } }
    new Function('require', 'module', 'exports', transformed.code)((name) => imports[name], module, module.exports)
    const html = renderToStaticMarkup(React.createElement(module.exports.default, { allowedRoles: ['venue_staff', 'coordinator'] }, 'Calendar content'))
    assert.equal(html.includes('Calendar content'), ['venue_staff', 'coordinator'].includes(role))
  }
})


test('calendar explains legacy grouping and distinguishes event from occupied time', () => {
  const page = harness()
  const booking = { ...block, id: 'booking', type: 'confirmed_booking', reason: 'Confirmed booking',
    event_start_at: '2026-11-20T10:30:00+08:00', event_end_at: '2026-11-20T11:30:00+08:00',
    legacy_blocks: [{ ...block, id: 'legacy', reason: 'Approved Booking: Workshop (Classroom)' }] }
  page.states[4].data = { ...data('hall', week.range, [booking]), sources: { operational_blocks:'verified', confirmed_bookings:'verified', tentative_holds:'verified', hold_expiry:'verified', venue_buffers:'verified' } }
  find(page.tree(), node => node.props['aria-label']?.startsWith('Confirmed booking:')).props.onClick()
  const markup = page.html()
  assert.match(markup, /Some older records need classification/)
  assert.match(markup, /Event period:/)
  assert.match(markup, /Occupied period above includes setup and turnaround/)
  assert.match(markup, /Matching older calendar records:/)
  assert.match(markup, /Approved Booking: Workshop/)
})
