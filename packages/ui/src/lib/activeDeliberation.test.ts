/**
 * PAR-1 — unit tests for the localStorage helpers used to survive refresh.
 *
 * The helpers are intentionally tiny but pin a public contract (key name,
 * trim semantics, error-tolerance) that App.tsx and any future caller
 * relies on. A regression here would silently re-introduce the
 * "card disappears on refresh" bug.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_DELIBERATION_KEY,
  clearActiveDeliberationId,
  getActiveDeliberationId,
  setActiveDeliberationId,
} from './activeDeliberation';

describe('activeDeliberation localStorage helpers (PAR-1)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('uses the namespaced key the rest of the app expects', () => {
    setActiveDeliberationId('abc-123');
    expect(window.localStorage.getItem(ACTIVE_DELIBERATION_KEY)).toBe('abc-123');
    expect(ACTIVE_DELIBERATION_KEY).toBe('parliament:active_deliberation_id');
  });

  it('round-trips an id via set/get', () => {
    setActiveDeliberationId('uuid-xyz');
    expect(getActiveDeliberationId()).toBe('uuid-xyz');
  });

  it('returns null when no id is set', () => {
    expect(getActiveDeliberationId()).toBeNull();
  });

  it('treats whitespace-only stored values as absent', () => {
    window.localStorage.setItem(ACTIVE_DELIBERATION_KEY, '   \n\t  ');
    expect(getActiveDeliberationId()).toBeNull();
  });

  it('clears the key with clearActiveDeliberationId', () => {
    setActiveDeliberationId('persisted');
    clearActiveDeliberationId();
    expect(window.localStorage.getItem(ACTIVE_DELIBERATION_KEY)).toBeNull();
    expect(getActiveDeliberationId()).toBeNull();
  });

  it('swallows storage errors during set', () => {
    const spy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('quota exceeded');
      });

    expect(() => setActiveDeliberationId('id')).not.toThrow();
    expect(spy).toHaveBeenCalled();
  });

  it('swallows storage errors during get and returns null', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('disabled');
    });

    expect(getActiveDeliberationId()).toBeNull();
  });

  it('swallows storage errors during clear', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('disabled');
    });

    expect(() => clearActiveDeliberationId()).not.toThrow();
  });
});
