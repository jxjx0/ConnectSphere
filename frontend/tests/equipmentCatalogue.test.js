import assert from 'node:assert/strict'
import test from 'node:test'

import {
  allocationOptions,
  allocationSummary,
  emptyLine,
  filterEquipment,
  equipmentTypes,
  isOfType,
  isBookable,
  lineProgress,
  linesToPayload,
  matchesRequest,
  OTHER_EQUIPMENT,
  removeBookingMessage,
  requestableTypes,
  requestWantsItem,
  statusTagClass,
  suggestLines,
  typeForName,
  uniqueEquipmentNames,
  validateLines,
} from '../src/equipmentCatalogue.js'

const mic = { id: 'mic', name: 'Wireless Microphone', type: 'Wireless Microphone', maintenance_status: 'Functional' }
const projector = { id: 'projector', name: 'Projector', type: 'Projector', maintenance_status: 'Functional' }
const spare = { id: 'spare', name: 'Projector', type: 'Projector', maintenance_status: 'Functional' }
const speaker = { id: 'speaker', name: 'Speaker', type: 'Speaker', maintenance_status: 'Under Repair' }
const old = { id: 'old', name: 'Old Projector', type: 'Projector', maintenance_status: 'Decommissioned' }
const catalogue = [mic, projector, spare, speaker, old]

test('only functional equipment can be booked', () => {
  assert.equal(isBookable(mic), true)
  assert.equal(isBookable(speaker), false)
  assert.equal(isBookable(old), false)
})

test('statuses are coloured by what they mean', () => {
  assert.equal(statusTagClass('Functional'), 'tag tag--good')
  assert.equal(statusTagClass('Pending Technical Approval'), 'tag tag--warning')
  assert.equal(statusTagClass('Decommissioned'), 'tag tag--danger')
  assert.equal(statusTagClass('Cancelled'), 'tag')
})

test('an existing name fills in its type, ignoring case and spaces', () => {
  assert.equal(typeForName(catalogue, '  wireless microphone '), 'Wireless Microphone')
  assert.equal(typeForName(catalogue, 'old projector'), 'Projector')
  assert.equal(typeForName(catalogue, 'Smoke machine'), '')
  assert.equal(typeForName(catalogue, ''), '')
})

test('names are listed once each, in order', () => {
  assert.deepEqual(
    uniqueEquipmentNames(catalogue),
    ['Old Projector', 'Projector', 'Speaker', 'Wireless Microphone'],
  )
})

test('the catalogue filters combine', () => {
  assert.deepEqual(filterEquipment(catalogue, { name: 'PROJ', status: 'Functional' }), [projector, spare])
  assert.deepEqual(filterEquipment(catalogue, { type: 'Projector', status: 'Decommissioned' }), [old])
  assert.deepEqual(filterEquipment(catalogue, {}), catalogue)
})

test('a request suggests equipment by a word of its name or type', () => {
  assert.equal(matchesRequest('2 microphones', mic), true)
  assert.equal(matchesRequest('a speaker for a panel', speaker), true)
  assert.equal(matchesRequest('1 projector', mic), false)
  assert.equal(matchesRequest(null, mic), false)
})

test('allocation options show each state, with what can be used first', () => {
  const request = { id: 'request-1', request_details: '1 projector' }
  const options = allocationOptions(catalogue, request, [
    { equipment_id: 'mic', request_id: 'request-1' },
    { equipment_id: 'spare', request_id: 'request-2', event_name: 'Other event' },
  ])

  assert.deepEqual(
    options.map((option) => [option.item.id, option.state]),
    [
      ['mic', 'allocated'],
      ['projector', 'available'],
      ['spare', 'booked'],
      ['old', 'unavailable'],
      ['speaker', 'unavailable'],
    ],
  )
  assert.equal(options[1].suggested, true)
  assert.equal(options[2].conflict.event_name, 'Other event')
})

test('suggested equipment sorts above other available equipment', () => {
  const options = allocationOptions([mic, projector], { id: 'r', request_details: '1 projector' }, [])
  assert.deepEqual(options.map((option) => option.item.id), ['projector', 'mic'])
})

test('old and new models count as the same type', () => {
  assert.equal(isOfType(old, 'projector'), true)
  assert.equal(isOfType(mic, 'Projector'), false)
  assert.deepEqual(equipmentTypes(catalogue), ['Projector', 'Speaker', 'Wireless Microphone'])
})

test('coordinators can only pick types with something usable in them', () => {
  assert.deepEqual(requestableTypes(catalogue), [
    { name: 'Projector', functional: 2 },
    { name: 'Wireless Microphone', functional: 1 },
  ])
})

const twoProjectors = {
  lines: [{ id: 'line-1', item_name: 'Projector', quantity: 2 }, { id: 'line-2', item_name: 'Fog machine', quantity: 1 }],
  equipment_bookings: [{ id: 'booking-1', line_id: 'line-1' }],
}

test('progress is counted per line and across the request', () => {
  const [first, second] = lineProgress(twoProjectors)
  assert.deepEqual([first.allocated, first.remaining, first.complete], [1, 1, false])
  assert.deepEqual([second.allocated, second.remaining, second.complete], [0, 1, false])
  assert.deepEqual(allocationSummary(twoProjectors), {
    tracked: true, allocated: 1, total: 3, remaining: 2, complete: false,
  })
})

test('a request is complete only when every line is full', () => {
  const full = {
    lines: [{ id: 'line-1', item_name: 'Projector', quantity: 1 }],
    equipment_bookings: [{ id: 'booking-1', line_id: 'line-1' }],
  }
  assert.equal(allocationSummary(full).complete, true)
})

test('a request from before lines only needs something allocated', () => {
  assert.equal(allocationSummary({ equipment_bookings: [] }).complete, false)
  assert.equal(allocationSummary({ equipment_bookings: [{ id: 'b' }] }).complete, true)
  assert.equal(allocationSummary({ equipment_bookings: [] }).tracked, false)
})

test('an item is wanted only by a line of its type with room left', () => {
  assert.equal(requestWantsItem(twoProjectors, projector), true)
  assert.equal(requestWantsItem(twoProjectors, mic), false)
  assert.equal(requestWantsItem({ lines: [] }, mic), true)
  assert.equal(requestWantsItem({
    lines: [{ id: 'line-1', item_name: 'Projector', quantity: 1 }],
    equipment_bookings: [{ id: 'b', line_id: 'line-1' }],
  }, projector), false)
})

test('rows are suggested from the organiser text, with quantities', () => {
  const types = requestableTypes(catalogue)
  assert.deepEqual(
    suggestLines('2 wireless microphones and a projector', types)
      .map((line) => [line.choice, line.quantity]),
    [['Projector', '1'], ['Wireless Microphone', '2']],
  )
  assert.deepEqual(suggestLines('3 projectors', types).map((line) => line.quantity), ['3'])
  assert.deepEqual(suggestLines('a smoke machine', types), [emptyLine()])
  assert.deepEqual(suggestLines(null, types), [emptyLine()])
})

test('rows must name equipment once each, with a sensible quantity', () => {
  const row = (choice, quantity = '1') => ({ ...emptyLine(), choice, quantity })
  assert.equal(validateLines([row('Projector')]), '')
  assert.match(validateLines([]), /Add the equipment/)
  assert.match(validateLines([row('')]), /Choose the equipment/)
  assert.match(validateLines([row(OTHER_EQUIPMENT)]), /Choose the equipment/)
  assert.match(validateLines([row('Projector'), row(OTHER_EQUIPMENT)]), /Choose the equipment/)
  assert.match(validateLines([row('Projector'), { ...row(OTHER_EQUIPMENT), otherName: ' projector ' }]), /listed twice/)
  assert.match(validateLines([row('Projector', '0')]), /quantity from 1 to 100/)
  assert.match(validateLines([row('Projector', '1.5')]), /quantity from 1 to 100/)
})

test('rows become what the backend expects', () => {
  assert.deepEqual(linesToPayload([
    { choice: 'Projector', otherName: '', quantity: '2', specifics: ' HDMI ' },
    { choice: OTHER_EQUIPMENT, otherName: ' Fog machine ', quantity: '1', specifics: '  ' },
  ]), [
    { item_name: 'Projector', quantity: 2, specifics: 'HDMI' },
    { item_name: 'Fog machine', quantity: 1, specifics: null },
  ])
})

test('removing a booking warns only when its request is already approved', () => {
  assert.equal(removeBookingMessage({ request_status: 'Pending Technical Approval' }), 'Remove this booking?')
  assert.match(
    removeBookingMessage({ request_status: 'Approved', event_name: 'Bootcamp' }),
    /Bootcamp is already approved.*short by this item/,
  )
})

test('missing data is handled, not assumed', () => {
  assert.deepEqual(lineProgress(null), [])
  assert.equal(allocationSummary(null).complete, false)
  assert.equal(typeForName([{ name: 'Fog machine' }], 'Fog machine'), '')
  assert.equal(matchesRequest('a tv', { name: 'TV', type: 'AV' }), false)
})

test('short type names are not guessed from the organiser text', () => {
  assert.deepEqual(suggestLines('a tv', [{ name: 'TV', functional: 1 }]), [emptyLine()])
})

test('an over-allocated line never counts for more than it asked for', () => {
  assert.deepEqual(allocationSummary({
    lines: [{ id: 'line-1', quantity: 1 }, { id: 'line-2', quantity: 1 }],
    equipment_bookings: [{ line_id: 'line-1' }, { line_id: 'line-1' }],
  }), { tracked: true, allocated: 1, total: 2, remaining: 1, complete: false })
})

test('every status has a tag colour', () => {
  assert.equal(statusTagClass('Approved'), 'tag tag--good')
  assert.equal(statusTagClass('Under Repair'), 'tag tag--warning')
  assert.equal(statusTagClass('Rejected'), 'tag tag--danger')
  assert.equal(statusTagClass('Affected by Session Change'), 'tag tag--danger')
})

test('a blank quantity is refused and an other row needs a name', () => {
  assert.match(validateLines([{ ...emptyLine(), choice: 'Projector', quantity: '' }]), /quantity/)
  assert.match(validateLines([{ ...emptyLine(), choice: 'Projector', quantity: '101' }]), /quantity/)
})

test('options with the same name and suggestion keep a stable, named order', () => {
  const zebra = { ...projector, id: 'zebra', name: 'Zebra' }
  const options = allocationOptions([zebra, projector], { id: 'r', request_details: 'zebra and projector' }, [])
  assert.deepEqual(options.map((option) => option.item.id), ['projector', 'zebra'])
})
