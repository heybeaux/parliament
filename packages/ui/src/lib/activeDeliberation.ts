/**
 * PAR-1 — refresh-survival for in-flight deliberations.
 *
 * The UI used to track the active deliberation id only in component state,
 * which meant a hard refresh wiped the in-progress card entirely. This module
 * centralises the localStorage handshake so:
 *
 *   1. `POST /deliberate` callers stash the returned id immediately.
 *   2. `App` checks the same key on mount and rehydrates from
 *      `GET /deliberate/:id`.
 *   3. Anything that "moves on" (terminal turn rendered, user picks a
 *      different transcript, etc.) clears the key so a subsequent refresh
 *      lands on a clean home view.
 *
 * The implementation is intentionally tiny and synchronous: there is no point
 * pulling in zustand / redux for a single string. Everything is wrapped in
 * try/catch because `localStorage` access can throw under privacy modes,
 * disabled storage, or SSR-style environments where `window` is missing.
 */

export const ACTIVE_DELIBERATION_KEY = 'parliament:active_deliberation_id';

function getStorage(): Storage | null {
  // jsdom + browsers expose `window.localStorage`. Guard for environments
  // where it is missing (older Safari private mode, certain test harnesses)
  // or where access throws.
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Persist the active in-flight deliberation id so a hard refresh can
 * rehydrate. No-ops silently if storage is unavailable; the worst case is
 * that refresh keeps showing the empty home view (the prior behavior),
 * never a runtime error in the live UI.
 */
export function setActiveDeliberationId(id: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(ACTIVE_DELIBERATION_KEY, id);
  } catch {
    // Quota errors / disabled storage — nothing useful to do here.
  }
}

/**
 * Read the persisted active deliberation id, or `null` if none is set or
 * storage is unavailable. Returns `null` for an empty/whitespace value so
 * downstream code can treat the result as a simple "do we have one?" flag.
 */
export function getActiveDeliberationId(): string | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(ACTIVE_DELIBERATION_KEY);
    if (!raw) return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Remove the persisted active deliberation id. Called on terminal turn
 * (live or resumed), when the user navigates to a stored deliberation /
 * transcript, and when rehydration fails (404, network error, etc.).
 */
export function clearActiveDeliberationId(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(ACTIVE_DELIBERATION_KEY);
  } catch {
    // ignore
  }
}
