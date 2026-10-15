// Render the actual JSX page with controlled request states; no browser library
// is added. Vite's existing transformer compiles JSX for React's server renderer.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { transformWithEsbuild } from 'vite'
import * as jsxRuntime from 'react/jsx-runtime'
import * as searchHelpers from '../src/venueSearch.js'
import * as eventDisplay from '../src/eventDisplay.js'
import * as eventCategories from '../src/eventCategories.js'

const source = await readFile(new URL('../src/pages/VenueSearchPage.jsx', import.meta.url), 'utf8')
const { code } = await transformWithEsbuild(source, 'VenueSearchPage.jsx', {
  jsx: 'automatic', format: 'cjs', tsconfigRaw: '{}',
})

function pageHarness(result, form = searchHelpers.EMPTY_VENUE_FILTERS, search = async () => ({ venues: [], warnings: [] }), options = {}) {
  let stateIndex = 0
  const eventId = options.eventId ?? null
  let params = new URLSearchParams(options.query || (eventId === null ? '' : `eventId=${encodeURIComponent(eventId)}`))
  const states = [form, result, { loading: false, error: '', options: ['Banquet', 'Theatre'], accessibilityOptions: ['Wheelchair access'], facilityOptions: ['Wi-Fi'] },
    options.context || { eventId, phase: eventId === null ? 'standalone' : 'loading', event: null, error: '' }]
  const effects = []
  const generation = { current: 0 }
  const module = { exports: {} }
  const imports = {
    react: {
      ...React, useEffect: (effect) => { effects.push(effect) }, useRef: () => generation,
      useState: () => {
        const index = stateIndex++
        return [states[index], (value) => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
      },
    },
    'react/jsx-runtime': jsxRuntime,
    'react-router-dom': {
      Link: ({ children, to, ...props }) => React.createElement('a', { ...props, href: to }, children),
      useSearchParams: () => [params, (next) => { params = next }],
    },
    '../api/venues': { searchVenues: search, getVenues: options.getVenues || (async () => ({ venues: [{ layouts: [{ name: 'Theatre' }] }] })) },
    '../api/events': { getAssignedEventRequest: options.getEvent || (() => { assert.fail('standalone search must not load an event') }) },
    '../eventDisplay': eventDisplay,
    '../components/AppShell': { __esModule: true, default: ({ children }) => React.createElement('main', null, children) },
    '../context/AuthContext': { useAuth: () => ({ token: 'token' }) },
    '../venueSearch.js': searchHelpers,
  }
  new Function('require', 'module', 'exports', code)(
    (name) => {
      assert.ok(name in imports, `unexpected import: ${name}`)
      return imports[name]
    }, module, module.exports,
  )
  return {
    states,
    params: () => params,
    load: async () => {
      stateIndex = 0; effects.length = 0; module.exports.default()
      const cleanup = effects[0]()
      await new Promise((resolve) => setImmediate(resolve))
      return cleanup
    },
    tree: () => { stateIndex = 0; return module.exports.default() },
    html: () => { stateIndex = 0; return renderToStaticMarkup(React.createElement(module.exports.default)) },
  }
}

function renderPage(result) { return pageHarness(result).html() }

function findElement(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => findElement(child, predicate)).find(Boolean)
  if (!React.isValidElement(node)) return undefined
  if (predicate(node)) return node
  return findElement(node.props.children, predicate)
}

const empty = { phase: 'success', error: '', venues: [], warnings: [] }

test('search retains filters in the URL and calendar links carry venue, date and event context', async () => {
  const result = { ...empty, venues: [{ id: 'hall', name: 'Hall', capacity: 100, layouts: [] }] }
  const page = pageHarness(result, { ...searchHelpers.EMPTY_VENUE_FILTERS, date: '2026-11-20' }, undefined, { eventId: 'event-1' })
  findElement(page.tree(), (node) => node.props.id === 'searchAttendance').props.onChange({ target: { value: '120' } })
  assert.equal(page.params().get('expected_attendance'), '120')
  page.states[1] = result
  const link = findElement(page.tree(), (node) => node.props.children === 'View Availability')
  const url = new URL(link.props.to, 'http://localhost')
  assert.equal(url.searchParams.get('venueId'), 'hall')
  assert.equal(url.searchParams.get('date'), '2026-11-20')
  const returnedQuery = url.searchParams.get('search')
  const returned = pageHarness(searchHelpers.INITIAL_VENUE_SEARCH, undefined, undefined, {
    eventId: 'event-1', query: returnedQuery,
    getEvent: async () => ({ event: { id: 'event-1', name: 'Workshop' } }),
  })
  await returned.load()
  assert.equal(returned.states[0].date, '2026-11-20')
  assert.equal(returned.states[0].expected_attendance, '120')
  assert.equal(returned.states[3].phase, 'success')
  assert.equal(returned.states[1].phase, 'idle')
  findElement(returned.tree(), (node) => node.type === 'button' && node.props.type === 'button').props.onClick()
  assert.equal(returned.params().get('eventId'), 'event-1')
  assert.equal(returned.params().get('expected_attendance'), null)
})

test('standalone search restores saved filters without loading an event or trusting old results', async () => {
  const page = pageHarness(searchHelpers.INITIAL_VENUE_SEARCH, undefined, () => assert.fail('returning must not silently search'), {
    query: 'filters=1&location=Campus+West&required_layout=Theatre&required_accessibility=Wheelchair+access&required_facility=Wi-Fi&date=2026-11-20&end_date=2026-11-21&start_time=22%3A00&end_time=02%3A00',
  })
  await page.load()
  assert.equal(page.states[0].required_layout, 'Theatre')
  assert.equal(page.states[0].required_accessibility, 'Wheelchair access')
  assert.equal(page.states[0].required_facility, 'Wi-Fi')
  assert.equal(page.states[0].location, 'Campus West')
  assert.equal(page.states[0].end_date, '2026-11-21')
  assert.equal(page.states[0].start_time, '22:00')
  assert.equal(page.states[1].phase, 'idle')
})

test('returning to results rechecks availability after validating the assigned event', async () => {
  const calls = []
  const options = { eventId: 'event-1', query: 'eventId=event-1&filters=1&resume=1&expected_attendance=120&location=West',
    getEvent: async () => { calls.push('event'); return { event: { id: 'event-1', name: 'Workshop' } } } }
  const page = pageHarness(searchHelpers.INITIAL_VENUE_SEARCH, undefined, async (payload) => {
    calls.push(payload); return { venues: [], warnings: [] }
  }, options)
  await page.load()
  assert.deepEqual(calls, ['event', { expected_attendance: 120, location: 'West' }])
  assert.equal(page.states[1].phase, 'success')
  const failed = pageHarness(searchHelpers.INITIAL_VENUE_SEARCH, undefined, () => assert.fail('failed event must not resume search'), {
    ...options, getEvent: async () => { throw new Error('Not assigned') },
  })
  await failed.load()
  assert.equal(failed.states[3].phase, 'error')
})

test('standalone resume refreshes results, while invalid filters do not request availability', async () => {
  const page = pageHarness(searchHelpers.INITIAL_VENUE_SEARCH, undefined, async () => ({ venues: [], warnings: [] }), {
    query: 'filters=1&resume=1&expected_attendance=100',
  })
  await page.load()
  assert.equal(page.states[1].phase, 'success')
  const invalid = pageHarness(searchHelpers.INITIAL_VENUE_SEARCH, undefined, () => assert.fail('invalid filters must not search'), {
    query: 'filters=1&resume=1&expected_attendance=-1',
  })
  await invalid.load()
  assert.equal(invalid.states[1].phase, 'error')
})

test('editing filters discards a pending resumed result', async () => {
  let resolve
  const page = pageHarness(searchHelpers.INITIAL_VENUE_SEARCH, undefined, () => new Promise((done) => { resolve = done }), {
    query: 'filters=1&resume=1&expected_attendance=100',
  })
  await page.load()
  assert.equal(page.states[1].phase, 'loading')
  findElement(page.tree(), (node) => node.props.id === 'searchAttendance').props.onChange({ target: { value: '120' } })
  resolve({ venues: [{ name: 'Stale Hall' }], warnings: [] })
  await new Promise((done) => setImmediate(done))
  assert.equal(page.states[1].phase, 'idle')
  assert.equal(page.params().get('resume'), null)
})

test('search page has optional period filters and a catalogue layout dropdown', () => {
  const html = renderPage({ ...empty, phase: 'idle' })
  for (const id of ['searchDate', 'searchEndDate', 'searchStart', 'searchEnd', 'searchAttendance', 'searchLayout', 'searchFacility']) {
    assert.ok(html.includes(`id="${id}"`))
  }
  assert.match(html, /<select id="searchLayout"/)
  assert.match(html, /Any layout/)
  assert.match(html, /<option value="Theatre">Theatre/)
  assert.ok(!html.includes(' required=""'))
  assert.match(html, /Clear filters/)
  assert.ok(!html.includes('No venues match'))
})

test('successful page displays venue name, selected layout, capacity and unverified availability', () => {
  const html = renderPage({
    ...empty,
    warnings: ['Bookings cannot yet be verified.'],
    venues: [{
      id: 'hall', name: 'Grand Hall', selected_layout: 'Theatre', layout_capacity: 100,
      capacity: 150, location: 'Campus West', layouts: [{ name: 'Theatre', capacity: 100 }],
      availability_status: 'unverified', requested_start: '2026-11-07T10:00:00+08:00',
      requested_end: '2026-11-07T12:00:00+08:00', effective_start: null, effective_end: null,
    }],
  })
  assert.match(html, /Grand Hall/)
  assert.match(html, /Theatre.*capacity 100/)
  assert.match(html, /Partially verified/)
  assert.match(html, /Availability is partially verified/)
  assert.match(html, /No operational block conflict/)
  assert.ok(!html.includes('Bookings cannot yet be verified.'))
  assert.match(html, /Campus West/)
  assert.match(html, /<table/)
  assert.ok(!html.includes('No venues match'))
})

test('empty results have an explicit message', () => {
  assert.match(renderPage(empty), /No venues match the selected filters\./)
})

test('request and validation errors render as alerts, not empty search results', () => {
  for (const error of ['Unable to access venue catalogue.', 'End time must be after start time.']) {
    const html = renderPage({ ...empty, phase: 'error', error })
    assert.ok(html.includes(error))
    assert.match(html, /role="alert"/)
    assert.ok(!html.includes('No venues match'))
  }
})

test('loading disables search inputs and shows progress', () => {
  const html = renderPage({ ...empty, phase: 'loading' })
  assert.match(html, /Searching venues/)
  assert.match(html, /aria-busy="true"/)
  assert.equal((html.match(/disabled=""/g) || []).length, 11)
})

const assignedEvent = Object.freeze({
  id: 'event-1', name: 'Planning workshop', start_time: '2026-11-07T22:00:00+08:00',
  end_time: '2026-11-08T02:00:00+08:00', expected_attendance: 100,
  layout_preference: ' theatre ', location_preference: 'West', accessibility_requirements: 'Step-free',
})

test('standalone mode loads catalogue without requesting an event', async () => {
  const harness = pageHarness(searchHelpers.INITIAL_VENUE_SEARCH)
  await harness.load()
  assert.deepEqual(harness.states[0], searchHelpers.EMPTY_VENUE_FILTERS)
  assert.match(harness.html(), /Back to Dashboard/)
  assert.ok(!harness.html().includes('Searching venues for:'))
})

test('event context loads assigned event, prefills filters, and returns to originating event', async () => {
  let calls = 0
  const harness = pageHarness(searchHelpers.INITIAL_VENUE_SEARCH, undefined, undefined, {
    eventId: assignedEvent.id,
    getEvent: async (id, token) => { calls++; assert.equal(id, assignedEvent.id); assert.equal(token, 'token'); return { event: assignedEvent } },
  })
  assert.match(harness.html(), /Loading assigned event/)
  await harness.load()
  assert.equal(calls, 1)
  assert.deepEqual(harness.states[0], searchHelpers.eventVenueFilters(assignedEvent, ['Theatre']))
  assert.equal(harness.states[0].expected_attendance, '100')
  assert.equal(harness.states[0].required_layout, 'Theatre')
  assert.match(harness.html(), /Searching venues for:.*Planning workshop/)
  assert.match(harness.html(), /href="\/event-reviews\/event-1"/)
  assert.match(harness.html(), /Back to Event/)
})

test('contextual filters are editable and search never writes the event', async () => {
  const before = JSON.stringify(assignedEvent)
  let payload
  const harness = pageHarness(searchHelpers.INITIAL_VENUE_SEARCH, undefined, async (data) => {
    payload = data; return { venues: [], warnings: [] }
  }, { eventId: assignedEvent.id, getEvent: async () => ({ event: assignedEvent }) })
  await harness.load()
  findElement(harness.tree(), (node) => node.props.id === 'searchAttendance').props.onChange({ target: { value: '120' } })
  await findElement(harness.tree(), (node) => node.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.equal(payload.expected_attendance, 120)
  assert.equal(JSON.stringify(assignedEvent), before)
  assert.equal(harness.states[3].event, assignedEvent)
  findElement(harness.tree(), (node) => node.type === 'button' && node.props.type === 'button').props.onClick()
  assert.deepEqual(harness.states[0], searchHelpers.EMPTY_VENUE_FILTERS)
  assert.match(harness.html(), /Planning workshop/)
})

for (const message of ['Event request was not found.', 'You do not have permission.', 'Network request failed.']) {
  test(`failed context blocks searching: ${message}`, async () => {
    const harness = pageHarness(searchHelpers.INITIAL_VENUE_SEARCH, undefined, () => assert.fail('failed context must not search'), {
      eventId: 'event-1', getEvent: async () => { throw new Error(message) },
    })
    await harness.load()
    assert.match(harness.html(), /Unable to load event context/)
    assert.ok(harness.html().includes(message))
    assert.match(harness.html(), /role="alert"/)
    assert.equal(findElement(harness.tree(), (node) => node.props.type === 'submit').props.disabled, true)
    await findElement(harness.tree(), (node) => node.type === 'form').props.onSubmit({ preventDefault() {} })
  })
}

test('unmatched layout is not silently mapped to another catalogue layout', async () => {
  const harness = pageHarness(searchHelpers.INITIAL_VENUE_SEARCH, undefined, undefined, {
    eventId: 'event-1', getEvent: async () => ({ event: { ...assignedEvent, layout_preference: 'Boardroom' } }),
  })
  await harness.load()
  assert.equal(harness.states[0].required_layout, '')
  assert.match(harness.html(), /preferred layout is not available/)
})

test('cancelled event loading cannot overwrite filters after leaving context', async () => {
  let resolveEvent
  const harness = pageHarness(searchHelpers.INITIAL_VENUE_SEARCH, undefined, undefined, {
    eventId: 'event-1', getEvent: () => new Promise((resolve) => { resolveEvent = resolve }),
  })
  const cleanup = await harness.load()
  cleanup()
  resolveEvent({ event: assignedEvent })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(harness.states[0], searchHelpers.EMPTY_VENUE_FILTERS)
})

test('event details offer contextual Find Venue only in Planning', async () => {
  const detailSource = await readFile(new URL('../src/pages/EventReviewDetailPage.jsx', import.meta.url), 'utf8')
  const compiled = await transformWithEsbuild(detailSource, 'EventReviewDetailPage.jsx', {
    jsx: 'automatic', format: 'cjs', tsconfigRaw: '{}',
  })
  for (const status of ['planning', 'under_review', 'confirmed', 'rejected']) {
    let index = 0
    const module = { exports: {} }
    const imports = {
      react: { ...React, useEffect: () => {}, useState: (initial) => {
        const current = index++
        return [current === 0 ? { ...assignedEvent, status, category: 'workshop' } : current === 12 ? false : initial, () => {}]
      } },
      'react/jsx-runtime': jsxRuntime,
      'react-router-dom': {
        Link: ({ children, to, ...props }) => React.createElement('a', { ...props, href: to }, children),
        useParams: () => ({ eventId: assignedEvent.id }),
      },
      '../api/events': {},
      '../components/AppShell': { __esModule: true, default: ({ children }) => React.createElement('main', null, children) },
      '../context/AuthContext': { useAuth: () => ({ token: 'token' }) },
      '../eventCategories': eventCategories,
      '../eventDisplay': eventDisplay,
    }
    new Function('require', 'module', 'exports', compiled.code)((name) => imports[name], module, module.exports)
    const html = renderToStaticMarkup(React.createElement(module.exports.default))
    assert.equal(html.includes('Find Venue'), status === 'planning')
    if (status === 'planning') assert.match(html, /href="\/venues\/search\?eventId=event-1"/)
  }
})

test('Coordinator dashboard prioritizes assigned events and keeps standalone browse as a text link', async () => {
  const link = ({ children, to, ...props }) => React.createElement('a', { ...props, href: to }, children)
  async function compilePage(path, imports) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8')
    const { code } = await transformWithEsbuild(source, path, { jsx: 'automatic', format: 'cjs', tsconfigRaw: '{}' })
    const module = { exports: {} }
    new Function('require', 'module', 'exports', code)((name) => {
      assert.ok(name in imports, `unexpected import: ${name}`)
      return imports[name]
    }, module, module.exports)
    return module.exports.default
  }
  const AssignedRequestTabs = await compilePage('../src/components/AssignedRequestTabs.jsx', {
    'react/jsx-runtime': jsxRuntime,
    'react-router-dom': { Link: link, useSearchParams: () => [new URLSearchParams('tab=ongoing'), () => {}] },
    '../eventDisplay': eventDisplay,
  })
  let stateIndex = 0
  const states = [[{ ...assignedEvent, status: 'planning' }], '', false]
  const DashboardPage = await compilePage('../src/pages/DashboardPage.jsx', {
    react: { ...React, useEffect: () => {}, useState: () => [states[stateIndex++], () => {}] },
    'react/jsx-runtime': jsxRuntime,
    'react-router-dom': { Link: link },
    '../api/events': {},
    '../components/AppShell': { __esModule: true, default: ({ children }) => React.createElement('main', null, children) },
    '../components/AssignedRequestTabs': { __esModule: true, default: AssignedRequestTabs },
    '../context/AuthContext': { useAuth: () => ({ token: 'token', user: { role: 'coordinator', full_name: 'Coordinator' } }) },
  })
  const html = renderToStaticMarkup(React.createElement(DashboardPage))
  assert.match(html, /Assigned Event Requests/)
  assert.match(html, /class="choice" href="\/event-reviews\/event-1"/)
  assert.match(html, /class="backlink" href="\/venues\/search">Browse Venues<\/a>/)
  assert.ok(!html.includes('Search Venues'))
  assert.ok(html.indexOf('Assigned Event Requests') < html.indexOf('Browse Venues'))
})

test('Clear filters resets every input and clears search errors/results', () => {
  const harness = pageHarness({ ...empty, phase: 'error', error: 'Request failed' }, {
    date: '2026-11-07', start_time: '10:00', end_time: '12:00', expected_attendance: '100', required_layout: 'Theatre',
  })
  findElement(harness.tree(), (node) => node.type === 'button' && node.props.type === 'button').props.onClick()
  assert.deepEqual(harness.states[0], searchHelpers.EMPTY_VENUE_FILTERS)
  assert.deepEqual(harness.states[1], searchHelpers.INITIAL_VENUE_SEARCH)
  assert.match(harness.html(), /Choose filters, or search to view all venues/)
  assert.ok(!harness.html().includes('Request failed'))
})

test('layout dropdown updates the filter without entering free text', () => {
  const harness = pageHarness(searchHelpers.INITIAL_VENUE_SEARCH)
  findElement(harness.tree(), (node) => node.props.id === 'searchLayout').props.onChange({ target: { value: 'Theatre' } })
  assert.equal(harness.states[0].required_layout, 'Theatre')
})

test('location input submits trimmed text, persists in URL and clears', async () => {
  let payload
  const page = pageHarness(searchHelpers.INITIAL_VENUE_SEARCH, undefined, async (data) => {
    payload = data; return { venues: [], warnings: [] }
  })
  assert.match(page.html(), /<label for="searchLocation">Location<\/label>/)
  const input = findElement(page.tree(), (node) => node.props.id === 'searchLocation')
  assert.equal(input.props.value, '')
  input.props.onChange({ target: { value: '  Campus West  ' } })
  assert.equal(page.params().get('location'), '  Campus West  ')
  await findElement(page.tree(), (node) => node.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.equal(payload.location, 'Campus West')
  findElement(page.tree(), (node) => node.type === 'button' && node.props.type === 'button').props.onClick()
  assert.equal(page.states[0].location, '')
  assert.equal(page.params().get('location'), null)
  await findElement(page.tree(), (node) => node.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.ok(!('location' in payload))
})

test('backend failure preserves entered filters', async () => {
  const form = { ...searchHelpers.EMPTY_VENUE_FILTERS, expected_attendance: '100', required_layout: 'Theatre' }
  const harness = pageHarness(searchHelpers.INITIAL_VENUE_SEARCH, form, async () => { throw new Error('Search failed') })
  await findElement(harness.tree(), (node) => node.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.deepEqual(harness.states[0], form)
  assert.equal(harness.states[1].error, 'Search failed')
  assert.match(harness.html(), /value="100"/)
})

test('untimed results show all layouts without implying availability', () => {
  const html = renderPage({ ...empty, venues: [{
    id: 'hall', name: 'Hall', capacity: 150, location: 'West',
    selected_layout: null, layout_capacity: null, availability_status: 'not_checked',
    layouts: [{ name: 'Theatre', capacity: 100 }, { name: 'Banquet', capacity: 80 }],
  }] })
  assert.match(html, /Theatre \(100\)/)
  assert.match(html, /Banquet \(80\)/)
  assert.ok(!html.includes('Requested:'))
  assert.ok(!html.includes('Available for the requested period'))
})

test('accessibility selection updates the search payload and Clear Filters resets it', async () => {
  let payload
  const harness = pageHarness(searchHelpers.INITIAL_VENUE_SEARCH, undefined, async (data) => { payload = data; return { venues: [], warnings: [] } })
  assert.match(harness.html(), /Any accessibility/)
  assert.match(harness.html(), /<option value="Wheelchair access">/)
  findElement(harness.tree(), (node) => node.props.id === 'searchAccessibility').props.onChange({ target: { value: 'Wheelchair access' } })
  await findElement(harness.tree(), (node) => node.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.equal(payload.required_accessibility, 'Wheelchair access')
  findElement(harness.tree(), (node) => node.type === 'button' && node.props.type === 'button').props.onClick()
  assert.equal(harness.states[0].required_accessibility, '')
})

test('facility single-select submits the selection and Clear Filters restores Any facility', async () => {
  let payload
  const harness = pageHarness(searchHelpers.INITIAL_VENUE_SEARCH, undefined, async (data) => { payload = data; return { venues: [], warnings: [] } })
  const select = findElement(harness.tree(), (node) => node.props.id === 'searchFacility')
  assert.equal(select.props.multiple, undefined)
  assert.equal(select.props.value, '')
  await findElement(harness.tree(), (node) => node.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.ok(!('required_facility' in payload))
  select.props.onChange({ target: { value: 'Wi-Fi' } })
  await findElement(harness.tree(), (node) => node.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.equal(payload.required_facility, 'Wi-Fi')
  findElement(harness.tree(), (node) => node.type === 'button' && node.props.type === 'button').props.onClick()
  assert.equal(harness.states[0].required_facility, '')
  assert.match(harness.html(), /<option value="" selected="">Any facility/)
})

test('facility catalogue aliases render one option and empty catalogue keeps the default', async () => {
  for (const venues of [[{ facilities: ['Wi-Fi', ' wifi ', 'WI-FI'] }], []]) {
    const harness = pageHarness(searchHelpers.INITIAL_VENUE_SEARCH, undefined, undefined, {
      getVenues: async () => ({ venues }),
    })
    await harness.load()
    const html = harness.html()
    assert.equal((html.match(/Any facility/g) || []).length, 1)
    assert.equal((html.match(/<option value="Wi-Fi">/g) || []).length, venues.length ? 1 : 0)
  }
})

test('catalogue accessibility aliases render one single-select option and one default', async () => {
  const harness = pageHarness(searchHelpers.INITIAL_VENUE_SEARCH, undefined, undefined, {
    getVenues: async () => ({ venues: [
      { accessibility: ['Wheelchair Accessible', ' wheelchair ACCESS ', 'Wheelchair accessible'] },
    ] }),
  })
  await harness.load()
  const selector = findElement(harness.tree(), (node) => node.props.id === 'searchAccessibility')
  assert.equal(selector.props.multiple, undefined)
  const html = harness.html()
  assert.equal((html.match(/<option value="Wheelchair access">/g) || []).length, 1)
  assert.equal((html.match(/Any accessibility/g) || []).length, 1)
  assert.ok(!html.includes('Wheelchair Accessible'))
})

test('timed results show one summary warning and one requested period across multiple rows', () => {
  const venue = { id: 'hall', name: 'Hall', capacity: 150, layouts: [], availability_status: 'unverified', requested_start: '2026-11-07T10:00:00+08:00', requested_end: '2026-11-07T12:00:00+08:00' }
  const html = renderPage({ ...empty, warnings: ['Bookings missing', 'Buffers missing'], venues: [venue, { ...venue, id: 'hall-2', name: 'Hall 2' }] })
  assert.equal((html.match(/Availability is partially verified/g) || []).length, 1)
  assert.equal((html.match(/Requested period:/g) || []).length, 1)
  assert.equal((html.match(/No operational block conflict/g) || []).length, 2)
  assert.ok(!html.includes('Requested:'))
  assert.ok(!html.includes('No conflict found'))
  assert.ok(!renderPage({ ...empty, venues: [{ ...venue, requested_start: null, requested_end: null, availability_status: 'not_checked' }] }).includes('Availability is partially verified'))
})
