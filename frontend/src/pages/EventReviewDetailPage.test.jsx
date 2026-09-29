import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import EventReviewDetailPage from './EventReviewDetailPage'
import {
  getAssignedEventRequest,
  getEventSupportingDocuments,
} from '../api/events'

vi.mock('../api/events', () => ({
  approveAssignedEvent: vi.fn(),
  getAssignedEventRequest: vi.fn(),
  getEventSupportingDocuments: vi.fn(),
  rejectAssignedEvent: vi.fn(),
}))

vi.mock('../components/AppShell', () => ({
  default: ({ children }) => <>{children}</>,
}))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ token: 'coordinator-token' }),
}))

const event = {
  id: 'event-123',
  name: 'Trump Conference',
  purpose: 'Annual conference',
  start_time: '2027-04-10T09:00:00Z',
  end_time: '2027-04-10T17:00:00Z',
  expected_attendance: 250,
  layout_preference: 'Theatre',
  equipment_requirements: 'Projector and microphones',
  accessibility_requirements: 'Step-free access',
  status: 'under_review',
}

function renderDetailPage() {
  return render(
    <MemoryRouter initialEntries={['/event-reviews/event-123']}>
      <Routes>
        <Route
          path="/event-reviews/:eventId"
          element={<EventReviewDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe('EventReviewDetailPage', () => {
  beforeEach(() => {
    getAssignedEventRequest.mockResolvedValue({ event })
    getEventSupportingDocuments.mockResolvedValue({ documents: [] })
  })

  afterEach(() => cleanup())

  it('loads event details and current status for the selected ID', async () => {
    renderDetailPage()

    expect(await screen.findByRole('heading', { name: event.name })).toBeTruthy()
    expect(screen.getByText(event.purpose)).toBeTruthy()
    expect(screen.getByText('250 people')).toBeTruthy()
    expect(screen.getByText(event.layout_preference)).toBeTruthy()
    expect(screen.getByText(event.equipment_requirements)).toBeTruthy()
    expect(screen.getByText(event.accessibility_requirements)).toBeTruthy()
    expect(screen.getByText('Under review')).toBeTruthy()
    expect(getAssignedEventRequest).toHaveBeenCalledWith(
      'event-123',
      'coordinator-token',
    )
  })

  it('shows a loading state while the event request is pending', () => {
    getAssignedEventRequest.mockReturnValue(new Promise(() => {}))

    renderDetailPage()

    expect(screen.getByText('Loading this event request…')).toBeTruthy()
  })

  it('shows an error and a return link when event retrieval fails', async () => {
    getAssignedEventRequest.mockRejectedValue(new Error('Event request was not found.'))

    renderDetailPage()

    expect(
      await screen.findByText('Event request was not found.'),
    ).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to assigned requests' })).toBeTruthy()
  })
})