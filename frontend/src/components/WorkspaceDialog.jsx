// A popup for the workspace pages. As a native dialog it keeps keyboard focus
// inside while open, and Escape closes it.

import { useEffect, useRef } from 'react'

export default function WorkspaceDialog({ title, onClose, children }) {
  const dialogRef = useRef(null)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className="workspace-dialog"
      aria-labelledby="workspace-dialog-title"
      onCancel={onClose}
    >
      <h2 id="workspace-dialog-title">{title}</h2>
      {children}
    </dialog>
  )
}
