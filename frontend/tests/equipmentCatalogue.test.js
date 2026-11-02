import assert from 'node:assert/strict'
import test from 'node:test'

import {
  allocationOptions,
  filterEquipment,
  isBookable,
  matchesRequest,
  statusTagClass,
  typeForName,
  uniqueEquipmentNames,
} from '../src/equipmentCatalogue.js'

const mic = { id: 'mic', name: 'Wireless Microphone', type: 'Audio', maintenance_status: 'Functional' }
const projector = { id: 'projector', name: 'Projector', type: 'Visual', maintenance_status: 'Functional' }
const spare = { id: 'spare', name: 'Projector', type: 'Visual', maintenance_status: 'Functional' }
const speaker = { id: 'speaker', name: 'Speaker', type: 'Audio', maintenance_status: 'Under Repair' }
const old = { id: 'old', name: 'Old Projector', type: 'Visual', maintenance_status: 'Decommissioned' }
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
  assert.equal(typeForName(catalogue, '  wireless microphone '), 'Audio')
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
  assert.deepEqual(filterEquipment(catalogue, { type: 'Audio', status: 'Under Repair' }), [speaker])
  assert.deepEqual(filterEquipment(catalogue, {}), catalogue)
})

test('a request suggests equipment by a word of its name or by its type', () => {
  assert.equal(matchesRequest('2 microphones', mic), true)
  assert.equal(matchesRequest('audio for a panel', speaker), true)
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
