import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as jsxRuntime from 'react/jsx-runtime'
import { transformWithEsbuild } from 'vite'
import * as attendeeRegistration from '../src/attendeeRegistration.js'
import * as eventCategories from '../src/eventCategories.js'
import * as eventDisplay from '../src/eventDisplay.js'
import * as eventStatus from '../src/eventStatus.js'

const source = await readFile(
  new URL('../src/pages/AttendeeEventDetailPage.jsx', import.meta.url),
  'utf8',
)
const { code } = await transformWithEsbuild(source, 'AttendeeEventDetailPage.jsx', {
  format: 'cjs',
  jsx: 'automatic',
  tsconfigRaw: '{}',
})

test('cancelled event detail shows its status and no registration form', async () => {
  const states = []
  const effects = []
  const navigations = []
  let stateIndex = 0
  const event = {
    id: 'cancelled-event',
    name: 'Annual Client Summit',
    status: 'cancelled',
    category: 'conference',
    start_time: '2099-12-01T09:00:00Z',
    end_time: '2099-12-01T17:00:00Z',
    registration_opens_at: '2099-11-01T09:00:00Z',
    registration_closes_at: '2099-11-20T09:00:00Z',
    attendee_capacity: 100,
    spots_left: 20,
    is_registered: true,
    sessions: [],
  }
  const imports = {
    react: {
      ...React,
      useEffect: (effect) => effects.push(effect),
      useState: (initial) => {
        const index = stateIndex++
        if (!(index in states)) {
          states[index] = typeof initial === 'function' ? initial() : initial
        }
        return [
          states[index],
          (value) => {
            states[index] = typeof value === 'function' ? value(states[index]) : value
          },
        ]
      },
    },
    'react/jsx-runtime': jsxRuntime,
    'react-router-dom': {
      Link: ({ to, children, ...props }) => React.createElement(
        'a', { ...props, href: to }, children,
      ),
      useNavigate: () => (path) => navigations.push(path),
      useParams: () => ({ eventId: event.id }),
    },
    '../api/events': {
      getPublishedEvent: async () => ({ event, account_email: 'casey@example.com' }),
      registerForEvent: async () => assert.fail('cancelled event must not submit registration'),
    },
    '../components/AppShell': {
      __esModule: true,
      default: ({ children }) => React.createElement('main', null, children),
    },
    '../components/RegistrationWithdrawal': {
      __esModule: true,
      default: ({ registration }) => registration.can_withdraw
        ? React.createElement('button', null, 'Withdraw registration')
        : null,
    },
    '../context/AuthContext': {
      useAuth: () => ({
        user: { full_name: 'Casey Attendee', contact_number: null },
        token: 'attendee-token',
      }),
    },
    '../attendeeRegistration': attendeeRegistration,
    '../eventCategories': eventCategories,
    '../eventDisplay': eventDisplay,
    '../eventStatus': eventStatus,
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(
    (name) => {
      assert.ok(name in imports, `unexpected import: ${name}`)
      return imports[name]
    },
    module,
    module.exports,
  )

  const Page = module.exports.default
  renderToStaticMarkup(React.createElement(Page))
  for (const effect of effects) effect()
  await new Promise((resolve) => setImmediate(resolve))

  stateIndex = 0
  const html = renderToStaticMarkup(React.createElement(Page))

  assert.match(html, /Event status: <strong>Cancelled<\/strong>/)
  assert.match(html, /This event has been cancelled\. Registration is closed\./)
  assert.doesNotMatch(html, /<form/)
  assert.doesNotMatch(html, />Register<\/button>/)
  assert.doesNotMatch(html, /Withdraw registration/)
  assert.deepEqual(navigations, [])
})
