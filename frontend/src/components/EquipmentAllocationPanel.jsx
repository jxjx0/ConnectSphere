// The side panel of Technical Support's request review. Work through what was
// requested one line at a time: the time is filled in from the request,
// availability is checked for every item of that line's type, and an item is
// allocated in one click. Remount it (by key) for each request.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import {
  createEquipmentBooking,
  getAllEquipmentBookings,
  getEquipmentBookings,
  notifyEquipmentLineUnavailable,
} from '../api/equipmentRequests'
import {
  allocationOptions,
  filterEquipment,
  isOfType,
  lineProgress,
} from '../equipmentCatalogue'
import { defaultBookingWindow, monthRange } from '../equipmentCalendar'
import { formatDateRange } from '../eventDisplay'
import styles from '../styles/TechSupport.module.css'
import EquipmentMonthCalendar, { stepMonth } from './EquipmentMonthCalendar'

const STATE_TAGS = {
  allocated: { label: 'Allocated', className: 'tag tag--good' },
  available: { label: 'Available', className: 'tag tag--good' },
  booked: { label: 'Already booked', className: 'tag tag--warning' },
}

export default function EquipmentAllocationPanel({ request, catalogue, token, onChanged }) {
  const bookingWindow = useMemo(() => defaultBookingWindow(request), [request])
  const startTime = bookingWindow?.start.getTime()
  const endTime = bookingWindow?.end.getTime()
  const lines = lineProgress(request)
  // Changes when an item is allocated or removed anywhere on the page, so what
  // is shown as available stays in step with the request.
  const allocationsKey = (request.equipment_bookings || []).map((booking) => booking.id).join()

  const [activeLineId, setActiveLineId] = useState('')
  const [overlapping, setOverlapping] = useState([])
  const [checking, setChecking] = useState(Boolean(bookingWindow))
  const [checkError, setCheckError] = useState('')
  const [nameFilter, setNameFilter] = useState('')
  const [savingId, setSavingId] = useState('')
  const [message, setMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const [chosenId, setChosenId] = useState('')
  const [month, setMonth] = useState(() => {
    const date = bookingWindow?.start || new Date()
    return { year: date.getFullYear(), month: date.getMonth() }
  })
  const [monthBookings, setMonthBookings] = useState([])
  const [monthError, setMonthError] = useState('')

  // Start on the first line that still needs something.
  const activeLine = lines.find((line) => line.id === activeLineId)
    || lines.find((line) => !line.complete)
    || lines[0]

  const loadAvailability = useCallback(() => {
    if (startTime === undefined) return Promise.resolve()
    setCheckError('')
    return getAllEquipmentBookings(new Date(startTime), new Date(endTime), token)
      .then((data) => setOverlapping(data.bookings))
      .catch((caught) => setCheckError(caught.message))
      .finally(() => setChecking(false))
  }, [endTime, startTime, token])

  useEffect(() => {
    loadAvailability()
  }, [allocationsKey, loadAvailability])

  // Items of the line's type. If the catalogue has none (an "Other" line), or
  // the request is from before lines, any item can be used.
  const typeItems = useMemo(
    () => (activeLine
      ? catalogue.filter((item) => isOfType(item, activeLine.item_name))
      : []),
    [activeLine?.item_name, catalogue], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const notInCatalogue = Boolean(activeLine) && typeItems.length === 0
  const lineItems = typeItems.length > 0 ? typeItems : catalogue
  const options = useMemo(
    () => allocationOptions(
      filterEquipment(lineItems, { name: nameFilter }),
      request,
      overlapping,
      activeLine ? activeLine.specifics : request.request_details,
    ),
    [activeLine?.specifics, lineItems, nameFilter, overlapping, request], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // Open on the item most likely to be wanted, so its schedule is on show.
  const chosen = lineItems.find((item) => item.id === chosenId)
    || options.find((option) => option.state === 'available')?.item
    || options[0]?.item

  const loadMonth = useCallback(() => {
    if (!chosen) return Promise.resolve()
    const { from, to } = monthRange(month.year, month.month)
    setMonthError('')
    return getEquipmentBookings(chosen.id, from, to, token)
      .then((data) => setMonthBookings(data.bookings))
      .catch((caught) => setMonthError(caught.message))
  }, [chosen, month, token])

  useEffect(() => {
    loadMonth()
  }, [allocationsKey, loadMonth])

  function chooseLine(lineId) {
    setActiveLineId(lineId)
    setChosenId('')
    setNameFilter('')
    setMessage('')
    setActionError('')
  }

  // The backend reports an unavailable item as a 409 once it has told the
  // Coordinator, so for Notify Coordinator that error is the expected result.
  async function submit(item, notifying) {
    setSavingId(item.id)
    setMessage('')
    setActionError('')
    try {
      await createEquipmentBooking({
        equipment_id: item.id,
        request_id: request.id,
        start_at: bookingWindow.start.toISOString(),
        end_at: bookingWindow.end.toISOString(),
        ...(notInCatalogue ? { line_id: activeLine.id } : {}),
      }, token)
      setMessage(`${item.name} (ID: ${item.id}) allocated.`)
      // Filling this line moves on to the next one still needing something.
      if (activeLine && activeLine.remaining === 1) setActiveLineId('')
      await onChanged()
    } catch (caught) {
      if (notifying && caught.status === 409) setMessage(caught.message)
      else setActionError(caught.message)
      await loadAvailability()
    } finally {
      setSavingId('')
    }
  }

  async function reportUnavailable() {
    setSavingId(activeLine.id)
    setMessage('')
    setActionError('')
    try {
      await notifyEquipmentLineUnavailable(request.id, activeLine.id, token)
      setMessage(`The Coordinator has been told ${activeLine.item_name} can't be supplied.`)
    } catch (caught) {
      setActionError(caught.message)
    } finally {
      setSavingId('')
    }
  }

  const lineFull = Boolean(activeLine?.complete)

  return (
    <aside className={styles.panel} aria-label="Allocate equipment">
      <div className={styles.panelHeader}>
        <h2 className="section-title" style={{ border: 0, padding: 0 }}>Allocate equipment</h2>
        <strong className={styles.panelTitle}>{request.event?.name || 'Assigned event'}</strong>
        {bookingWindow && (
          <span className="note">
            Needed for {formatDateRange(bookingWindow.start, bookingWindow.end)}.
            {' '}Bookings use this time automatically.
          </span>
        )}
      </div>

      {!bookingWindow && (
        <p className="note">
          This request has no valid session or venue booking time yet, so nothing can be allocated.
        </p>
      )}

      {bookingWindow && (
        <>
          {message && <p className="form-success" role="status">{message}</p>}
          {actionError && <p className="form-error" role="alert">{actionError}</p>}
          {checkError && <p className="form-error" role="alert">{checkError}</p>}

          {lines.length > 0 && (
            <ul className={styles.lineTabs} aria-label="Requested equipment">
              {lines.map((line) => (
                <li key={line.id}>
                  <button
                    type="button"
                    className={`${styles.lineTab} ${activeLine?.id === line.id ? styles.lineTabActive : ''}`}
                    aria-pressed={activeLine?.id === line.id}
                    onClick={() => chooseLine(line.id)}
                  >
                    <span>{line.item_name}</span>
                    <span className={line.complete ? 'tag tag--good' : 'tag tag--warning'}>
                      {line.allocated}/{line.quantity}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {activeLine && (
            <div className={styles.lineSummary}>
              <strong>
                {activeLine.complete
                  ? `All ${activeLine.item_name} allocated`
                  : `${activeLine.remaining} more ${activeLine.item_name} to allocate`}
              </strong>
              {activeLine.specifics && (
                <span className="note">Coordinator's specifics: {activeLine.specifics}</span>
              )}
            </div>
          )}

          {notInCatalogue && !lineFull && (
            <div className="stack stack--tight">
              <p className="note">
                {activeLine.item_name} isn't in the catalogue. Add it if you have sourced it,
                or choose something suitable below.
              </p>
              <div className="form-actions">
                <Link
                  to={`/equipment/new?type=${encodeURIComponent(activeLine.item_name)}`}
                  className="button button--small"
                >
                  Add {activeLine.item_name} to catalogue
                </Link>
                <button
                  type="button"
                  className="button button--secondary button--small"
                  disabled={Boolean(savingId)}
                  onClick={reportUnavailable}
                >
                  {savingId === activeLine.id ? 'Sending…' : 'Notify Coordinator'}
                </button>
              </div>
            </div>
          )}

          {lineItems.length === 0 ? (
            <p className="note">The catalogue is empty.</p>
          ) : (
            <>
              {lineItems.length > 5 && (
                <div className="field">
                  <label htmlFor="allocation-search">Find equipment</label>
                  <input
                    id="allocation-search"
                    type="search"
                    placeholder="Search by name…"
                    value={nameFilter}
                    onChange={(change) => setNameFilter(change.target.value)}
                  />
                </div>
              )}

              {checking && <p className="note">Checking availability…</p>}

              {!checking && !checkError && options.length === 0 && (
                <p className="note">No equipment matches this search.</p>
              )}

              {!checking && !checkError && options.length > 0 && (
                <ul className={styles.options}>
                  {options.map(({ item, state, conflict, suggested }) => (
                    <li
                      key={item.id}
                      className={`${styles.option} ${chosen?.id === item.id ? styles.optionChosen : ''}`}
                    >
                      <button
                        type="button"
                        className={styles.optionText}
                        aria-pressed={chosen?.id === item.id}
                        onClick={() => setChosenId(item.id)}
                      >
                        <span className={styles.optionName}>{item.name}</span>
                        <span className={styles.equipmentId}>ID: {item.id}</span>
                        <span className={styles.tags}>
                          <span className={STATE_TAGS[state]?.className || 'tag tag--danger'}>
                            {STATE_TAGS[state]?.label || item.maintenance_status}
                          </span>
                          {suggested && state === 'available' && (
                            <span className={`tag ${styles.suggested}`}>Suggested</span>
                          )}
                        </span>
                        {state === 'booked' && conflict?.event_name && (
                          <span className={styles.optionMeta}>Booked for {conflict.event_name}</span>
                        )}
                      </button>
                      {state === 'available' && (
                        <button
                          type="button"
                          className="button button--small"
                          disabled={Boolean(savingId) || lineFull}
                          title={lineFull ? `All ${activeLine.item_name} have been allocated.` : undefined}
                          onClick={() => submit(item, false)}
                        >
                          {savingId === item.id ? 'Saving…' : 'Allocate'}
                        </button>
                      )}
                      {(state === 'booked' || state === 'unavailable') && !lineFull && (
                        <button
                          type="button"
                          className="button button--secondary button--small"
                          disabled={Boolean(savingId)}
                          title="Tell the Coordinator this item is unavailable, so they can arrange an alternative."
                          onClick={() => submit(item, true)}
                        >
                          {savingId === item.id ? 'Sending…' : 'Notify Coordinator'}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {chosen && (
            <section className="stack stack--tight">
              <h3 className="section-title">{chosen.name} schedule</h3>
              <p className={styles.equipmentId}>ID: {chosen.id}</p>
              {monthError && <p className="form-error" role="alert">{monthError}</p>}
              <EquipmentMonthCalendar
                title={`${chosen.name} bookings`}
                year={month.year}
                month={month.month}
                bookings={monthBookings}
                describe={(booking) => booking.event_name}
                onChangeMonth={(step) => setMonth((current) => stepMonth(current, step))}
              />
              <Link to={`/equipment/${chosen.id}/bookings`}>Open full schedule</Link>
            </section>
          )}
        </>
      )}
    </aside>
  )
}
