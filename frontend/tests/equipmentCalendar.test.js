import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bookingsOnDay,
  defaultBookingWindow,
  monthRange,
  monthWeeks,
  toLocalInputValue,
} from '../src/equipmentCalendar.js'

test('month weeks start on Monday and cover the whole month', () => {
  const weeks = monthWeeks(2026, 9) // October 2026 starts on a Thursday
  assert.equal(weeks[0][0].getDay(), 1)
  assert.equal(weeks[0][0].getDate(), 28) // Mon 28 Sep
  assert.equal(weeks[0][3].getDate(), 1)
  assert.ok(weeks.every((week) => week.length === 7))
  const days = weeks.flat().filter((day) => day.getMonth() === 9)
  assert.equal(days.length, 31)
})

test('month weeks drop a trailing week that is all next month', () => {
  const weeks = monthWeeks(2026, 1) // February 2026: Mon 2 Feb ... Sun 1 Mar
  assert.equal(weeks[weeks.length - 1].some((day) => day.getMonth() === 1), true)
})

test('month range runs from the first of the month to the first of the next', () => {
  const { from, to } = monthRange(2026, 11)
  assert.equal(from.getTime(), new Date(2026, 11, 1).getTime())
  assert.equal(to.getTime(), new Date(2027, 0, 1).getTime())
})

test('bookings show on every local day they overlap', () => {
  const overnight = {
    id: 'overnight',
    start_at: new Date(2026, 9, 1, 22).toISOString(),
    end_at: new Date(2026, 9, 2, 2).toISOString(),
  }
  const endsAtMidnight = {
    id: 'ends-at-midnight',
    start_at: new Date(2026, 9, 1, 20).toISOString(),
    end_at: new Date(2026, 9, 2).toISOString(),
  }
  const bookings = [overnight, endsAtMidnight]

  assert.deepEqual(
    bookingsOnDay(bookings, new Date(2026, 9, 1)).map((booking) => booking.id),
    ['overnight', 'ends-at-midnight'],
  )
  assert.deepEqual(
    bookingsOnDay(bookings, new Date(2026, 9, 2)).map((booking) => booking.id),
    ['overnight'],
  )
})

test('default booking window spans all of the request event windows', () => {
  const request = {
    bookings: [
      { start_at: '2026-10-23T05:00:00Z', end_at: '2026-10-23T06:00:00Z' },
      { start_at: '2026-10-23T02:00:00Z', end_at: '2026-10-23T04:00:00Z' },
    ],
  }
  const window = defaultBookingWindow(request)
  assert.equal(window.start.toISOString(), '2026-10-23T02:00:00.000Z')
  assert.equal(window.end.toISOString(), '2026-10-23T06:00:00.000Z')
})

test('requests without event windows have no default booking time', () => {
  assert.equal(defaultBookingWindow({ bookings: [] }), null)
  assert.equal(defaultBookingWindow(undefined), null)
})

test('local input values preserve seconds when round-tripping datetime-local', () => {
  const date = new Date(2026, 9, 3, 9, 5, 7)
  const value = toLocalInputValue(date)
  assert.equal(value, '2026-10-03T09:05:07')
  assert.equal(new Date(value).getTime(), date.getTime())
})
