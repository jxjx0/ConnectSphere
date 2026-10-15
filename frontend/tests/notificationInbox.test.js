import assert from 'node:assert/strict'
import test from 'node:test'

import {
  countUnread,
  inboxLabel,
  markReadInList,
} from '../src/notificationInbox.js'

const notifications = [
  { id: 'a', title: 'Approved', is_read: false },
  { id: 'b', title: 'Assigned', is_read: true },
  { id: 'c', title: 'Clarification', is_read: false },
]

test('countUnread counts only unread notifications', () => {
  assert.equal(countUnread(notifications), 2)
  assert.equal(countUnread([]), 0)
})

test('markReadInList marks only the opened notification read', () => {
  const updated = markReadInList(notifications, 'a')
  assert.deepEqual(updated.map((n) => n.is_read), [true, true, false])
  assert.equal(countUnread(updated), 1)
})

test('markReadInList does not change the original list', () => {
  markReadInList(notifications, 'a')
  assert.equal(notifications[0].is_read, false)
})

test('inboxLabel shows the unread count only when there is one', () => {
  assert.equal(inboxLabel(0), 'Inbox')
  assert.equal(inboxLabel(3), 'Inbox (3)')
})
