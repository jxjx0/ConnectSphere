import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'

import {
  EMPTY_VENUE_FILTERS, runVenueSearch, validateVenueSearch, venueSearchPayload,
  venueAvailabilityLabel, venueLayoutOptions, eventVenueFilters, venueAccessibilityOptions, venueAvailabilitySummary, venueFacilityOptions,
} from '../src/venueSearch.js'

const form = {
  date: '2026-11-07', start_time: '10:00', end_time: '12:00',
  expected_attendance: '100', required_layout: ' Theatre ',
}

test('valid form creates numeric attendance and an explicit timezone offset', () => {
  assert.equal(validateVenueSearch(form), null)
  const payload = venueSearchPayload(form)
  assert.equal(payload.expected_attendance, 100)
  assert.equal(payload.required_layout, 'Theatre')
  assert.equal(payload.timezone_offset_minutes, -new Date('2026-11-07T10:00').getTimezoneOffset())
})

for (const changes of [
  { date: '' }, { date: '2026-02-30' }, { start_time: '24:00' },
  { end_time: '10:00' }, { end_time: '09:00' }, { expected_attendance: '0' },
  { expected_attendance: '-1' }, { expected_attendance: '1.5' },
]) {
  test(`invalid form is rejected: ${JSON.stringify(changes)}`, () => {
    assert.ok(validateVenueSearch({ ...form, ...changes }))
  })
}

for (const filters of [
  {}, { expected_attendance: '100' }, { required_layout: 'Theatre' },
  { expected_attendance: '100', required_layout: 'Theatre' },
  { date: form.date, start_time: form.start_time, end_time: form.end_time },
  { ...form, required_layout: '' }, { ...form, expected_attendance: '' }, form,
]) {
  test(`optional filter combination submits: ${JSON.stringify(filters)}`, async () => {
    const input = { ...EMPTY_VENUE_FILTERS, ...filters }
    assert.equal(validateVenueSearch(input), null)
    let captured
    const result = await runVenueSearch(input, 'token', async (payload) => {
      captured = payload
      return { venues: [], warnings: [] }
    })
    assert.equal(result.phase, 'success')
    if (!input.date) assert.ok(!('timezone_offset_minutes' in captured))
    if (!input.expected_attendance) assert.ok(!('expected_attendance' in captured))
    if (!input.required_layout) assert.ok(!('required_layout' in captured))
  })
}

test('empty search sends an empty object, not zero attendance or invalid timestamps', () => {
  assert.deepEqual(venueSearchPayload(EMPTY_VENUE_FILTERS), {})
})

test('location payload trims text, preserves literal characters and omits blank input', () => {
  for (const location of [undefined, null, '', ' \t\n ']) {
    assert.deepEqual(venueSearchPayload({ ...EMPTY_VENUE_FILTERS, location }), {})
  }
  const payload = venueSearchPayload({ ...form, location: '  West%_  ', required_accessibility: 'Step-free', required_facility: 'Wi-Fi' })
  assert.equal(payload.location, 'West%_')
  assert.equal(payload.required_layout, 'Theatre')
  assert.equal(payload.expected_attendance, 100)
  assert.equal(payload.required_accessibility, 'Step-free')
  assert.equal(payload.required_facility, 'Wi-Fi')
  assert.equal(eventVenueFilters({ start_time: '2026-11-07T10:00Z', end_time: '2026-11-07T12:00Z', location_preference: 'Somewhere central near an MRT' }, []).location, '')
})

test('facility options normalize safe aliases and support existing catalogue formats without mutation', () => {
  const venues = [
    { facilities: [' Wi-Fi ', 'wifi', 'WI   FI', ' Projector ', 'PROJECTOR', 'Wi-Fi hotspot', '', null] },
    { facilities: 'wifi' }, { facilities: { parking: true, projectors: 2, wifi: false, pool: 0, gym: -1, unknown: 'maybe' } },
    { facilities: null }, {}, { facilities: [] }, { facilities: 5 },
  ]
  const before = JSON.stringify(venues)
  assert.deepEqual(venueFacilityOptions(venues), ['parking', 'Projector', 'projectors', 'Wi-Fi', 'Wi-Fi hotspot'])
  assert.equal(JSON.stringify(venues), before)
  assert.deepEqual(venueFacilityOptions([]), [])
})

test('facility is optional and combines with existing filter payloads', () => {
  assert.deepEqual(venueSearchPayload({ ...EMPTY_VENUE_FILTERS, required_facility: ' ' }), {})
  const payload = venueSearchPayload({ ...form, required_accessibility: 'Wheelchair access', required_facility: ' WIFI ' })
  assert.equal(payload.required_facility, 'Wi-Fi')
  assert.equal(payload.required_accessibility, 'Wheelchair access')
  assert.equal(payload.required_layout, 'Theatre')
  assert.equal(payload.expected_attendance, 100)
  assert.equal(payload.date, form.date)
  assert.equal(eventVenueFilters({ start_time: '2026-11-07T10:00Z', end_time: '2026-11-07T12:00Z', equipment_requirements: 'Wi-Fi' }, []).required_facility, '')
})

test('layout options come from catalogue data, with case-insensitive deduplication', () => {
  assert.deepEqual(venueLayoutOptions([
    { layouts: [{ name: 'Theatre' }, { name: 'Banquet' }] },
    { layouts: [{ name: ' theatre ' }, { name: 'Classroom' }] },
  ]), ['Banquet', 'Classroom', 'Theatre'])
})

test('incomplete time filter explains the required group', () => {
  assert.match(validateVenueSearch({ ...EMPTY_VENUE_FILTERS, start_time: '10:00' }), /date, start time and end time together/)
})

test('validation errors prevent API requests', async () => {
  const result = await runVenueSearch({ ...form, expected_attendance: '0' }, 'token', () => {
    assert.fail('invalid search must not reach API')
  })
  assert.equal(result.phase, 'error')
  assert.match(result.error, /positive integer/)
})

test('successful results preserve availability warnings and selected layout capacity', async () => {
  const venues = [{ name: 'Hall', selected_layout: 'Theatre', layout_capacity: 100, availability_status: 'unverified' }]
  const result = await runVenueSearch(form, 'caller-token', async (payload, token) => {
    assert.equal(token, 'caller-token')
    assert.equal(payload.expected_attendance, 100)
    return { venues, warnings: ['Booking availability cannot yet be verified.'] }
  })
  assert.equal(result.phase, 'success')
  assert.deepEqual(result.venues, venues)
  assert.equal(result.warnings.length, 1)
  assert.equal(venueAvailabilityLabel(venues[0]), 'Partially verified')
})

test('no results is a successful empty search, not a request error', async () => {
  const result = await runVenueSearch(form, 'token', async () => ({ venues: [], warnings: [] }))
  assert.equal(result.phase, 'success')
  assert.deepEqual(result.venues, [])
  assert.equal(result.error, '')
})

test('backend errors clear results and are presented as errors', async () => {
  const result = await runVenueSearch(form, 'token', async () => { throw new Error('Unable to access catalogue.') })
  assert.equal(result.phase, 'error')
  assert.equal(result.error, 'Unable to access catalogue.')
  assert.deepEqual(result.venues, [])
})

test('multi-date periods preserve end date and its timezone offset', () => {
  const overnight = { ...form, start_time: '22:00', end_date: '2026-11-08', end_time: '02:00' }
  assert.equal(validateVenueSearch(overnight), null)
  const payload = venueSearchPayload(overnight)
  assert.equal(payload.end_date, '2026-11-08')
  assert.equal(payload.end_timezone_offset_minutes, -new Date('2026-11-08T02:00').getTimezoneOffset())
  for (const end_date of ['2026-11-06', '2026-02-30', 'bad']) {
    assert.ok(validateVenueSearch({ ...overnight, end_date }))
  }
  assert.ok(validateVenueSearch({ ...EMPTY_VENUE_FILTERS, end_date: '2026-11-08' }))
})

test('event prefill converts UTC timestamps into local dates, including overnight events', () => {
  const helperUrl = new URL('../src/venueSearch.js', import.meta.url).href
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { eventVenueFilters } from ${JSON.stringify(helperUrl)};
    const event = { start_time: '2026-11-07T16:30:00Z', end_time: '2026-11-08T17:00:00Z', expected_attendance: 80, layout_preference: ' theatre ' };
    const filters = eventVenueFilters(event, ['Theatre']);
    assert.equal(filters.date, '2026-11-08');
    assert.equal(filters.start_time, '00:30');
    assert.equal(filters.end_date, '2026-11-09');
    assert.equal(filters.end_time, '01:00');
    assert.equal(filters.expected_attendance, '80');
    assert.equal(filters.required_layout, 'Theatre');
    assert.equal(eventVenueFilters({ ...event, end_time: '2026-11-07T18:00:00Z' }, []).end_date, '');
  `], { env: { ...process.env, TZ: 'Asia/Singapore' }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('invalid event periods cannot be used for contextual prefill', () => {
  assert.throws(() => eventVenueFilters({ start_time: 'bad', end_time: 'bad' }, []), /invalid scheduled period/)
})

test('accessibility options use catalogue values and ignore empty data', () => {
  assert.deepEqual(venueAccessibilityOptions([
    { accessibility: ['Wheelchair access', ' Step-free ', ''] },
    { accessibility: ['wheelchair access'] }, { accessibility: null }, {},
  ]), ['Step-free', 'Wheelchair access'])
  assert.deepEqual(venueSearchPayload({ ...EMPTY_VENUE_FILTERS, required_accessibility: ' ' }), {})
  assert.equal(venueSearchPayload({ ...EMPTY_VENUE_FILTERS, required_accessibility: ' Wheelchair access ' }).required_accessibility, 'Wheelchair access')
  assert.equal(eventVenueFilters({ start_time: '2026-11-07T10:00Z', end_time: '2026-11-07T12:00Z', expected_attendance: 100, accessibility_requirements: 'Wheelchair access' }, []).required_accessibility, '')
})

test('accessibility aliases and case variants produce one option without changing catalogue data', () => {
  const venues = [{ accessibility: [' Wheelchair Accessible ', 'wheelchair access', ' WHEELCHAIR   ACCESSIBLE ', ' Hearing loop ', 'HEARING LOOP', 'Wheelchair access ramp'] }]
  const before = JSON.stringify(venues)
  assert.deepEqual(venueAccessibilityOptions(venues), ['Hearing loop', 'Wheelchair access', 'Wheelchair access ramp'])
  assert.equal(JSON.stringify(venues), before)
  assert.equal(venueSearchPayload({ ...EMPTY_VENUE_FILTERS, required_accessibility: ' WHEELCHAIR Accessible ' }).required_accessibility, 'Wheelchair access')
  assert.deepEqual(venueAccessibilityOptions([{ accessibility: ['wheelchair accessible'] }]), ['Wheelchair access'])
})

test('availability summary appears only for timed partial responses', () => {
  const partial = { venues: [], warnings: ['Bookings missing', 'Buffers missing'], requested_period: { start: '2026-11-07T10:00', end: '2026-11-07T12:00' } }
  assert.match(venueAvailabilitySummary(partial), /Some reservation conflicts may not be shown/)
  assert.equal(venueAvailabilitySummary({ venues: [], warnings: [] }), '')
  assert.equal(venueAvailabilitySummary({ ...partial, warnings: [], venues: [{ availability_status: 'available' }] }), '')
  assert.equal(venueAvailabilitySummary({ venues: [{ availability_status: 'not_checked' }], warnings: ['irrelevant'] }), '')
})

test('partial search with configured buffers does not describe setup and turnaround as unfinished', () => {
  const summary = venueAvailabilitySummary({
    requested_period: { start: '2026-11-07T10:00', end: '2026-11-07T12:00' },
    warnings: ['Booking and tentative hold availability cannot yet be verified.'],
    venues: [{ availability_status: 'unverified',
      effective_start: '2026-11-07T09:30', effective_end: '2026-11-07T12:45' }],
  })
  assert.match(summary, /Availability is partially verified/)
  assert.doesNotMatch(summary, /setup|turnaround|operational/i)
})
