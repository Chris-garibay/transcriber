import { useCallback, useRef, useState } from 'react'

/**
 * An in-app replacement for `window.prompt`, which Electron does not implement
 * -- calling it throws "prompt() is and will not be supported." Every caller
 * here invoked it inside a `void`-ed async function, so the throw became an
 * unhandled rejection and the button silently did nothing.
 *
 * Returns the entered text, or null if the user cancelled.
 */
export interface PromptOptions {
  message: string
  initial?: string
  confirmLabel?: string
}

interface PendingPrompt extends PromptOptions {
  resolve: (value: string | null) => void
}

export function usePrompt(): {
  ask: (options: PromptOptions) => Promise<string | null>
  dialog: JSX.Element | null
} {
  const [pending, setPending] = useState<PendingPrompt | null>(null)
  const [value, setValue] = useState('')
  // Held in a ref so settling never depends on which render closed over it.
  const pendingRef = useRef<PendingPrompt | null>(null)

  const ask = useCallback((options: PromptOptions) => {
    return new Promise<string | null>((resolve) => {
      // A second prompt while one is open would strand the first for ever.
      pendingRef.current?.resolve(null)
      const next = { ...options, resolve }
      pendingRef.current = next
      setValue(options.initial ?? '')
      setPending(next)
    })
  }, [])

  const settle = useCallback((result: string | null) => {
    const current = pendingRef.current
    pendingRef.current = null
    setPending(null)
    current?.resolve(result)
  }, [])

  const dialog = pending ? (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) settle(null)
      }}
    >
      <form
        className="modal"
        onSubmit={(e) => {
          e.preventDefault()
          settle(value.trim() ? value : null)
        }}
      >
        <label htmlFor="prompt-input">{pending.message}</label>
        <input
          id="prompt-input"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              settle(null)
            }
          }}
        />
        <div className="modal-actions">
          <button type="button" onClick={() => settle(null)}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!value.trim()}>
            {pending.confirmLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </div>
  ) : null

  return { ask, dialog }
}
