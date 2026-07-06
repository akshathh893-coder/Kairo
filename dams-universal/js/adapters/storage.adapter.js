'use strict';

/**
 * @file adapters/storage.adapter.js
 * @description Concrete {@link StorageAdapter} implementations plus a
 * {@link SessionStore} that layers the app's session model on top of any
 * adapter. This is where persistence is decoupled from everything else:
 *
 *   - LocalStorageAdapter  — browser default (wraps window.localStorage).
 *   - MemoryStorageAdapter — in-process map; used for headless embedding
 *     (Kairos AI can inject its own persistence) and for isolated unit tests.
 *
 * Any object satisfying the StorageAdapter protocol can be swapped in, so the
 * host application may provide, e.g., an adapter backed by iOS Keychain / files
 * via a WKWebView bridge without changing the quiz engine.
 */

;(function (DAMS) {
  const NS = 'dams-universal:';

  /**
   * Browser localStorage-backed adapter. Every call is defensive so a full or
   * unavailable localStorage degrades gracefully instead of throwing.
   * @implements {import('../core/interfaces.js').StorageAdapter}
   */
  class LocalStorageAdapter {
    /** @param {string} [namespace] */
    constructor(namespace = NS) {
      this.ns = namespace;
    }
    get(key, fallback = null) {
      try {
        const raw = localStorage.getItem(this.ns + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    }
    set(key, value) {
      try {
        localStorage.setItem(this.ns + key, JSON.stringify(value));
        return true;
      } catch (err) {
        console.warn('[LocalStorageAdapter] set failed', key, err);
        return false;
      }
    }
    remove(key) {
      try {
        localStorage.removeItem(this.ns + key);
      } catch {
        /* noop */
      }
    }
    clear() {
      try {
        Object.keys(localStorage)
          .filter((k) => k.startsWith(this.ns))
          .forEach((k) => localStorage.removeItem(k));
      } catch {
        /* noop */
      }
    }
    keys() {
      try {
        return Object.keys(localStorage)
          .filter((k) => k.startsWith(this.ns))
          .map((k) => k.slice(this.ns.length));
      } catch {
        return [];
      }
    }
  }

  /**
   * In-memory adapter. Deep-copies on write via JSON so callers cannot mutate
   * stored state by reference — matching localStorage semantics.
   * @implements {import('../core/interfaces.js').StorageAdapter}
   */
  class MemoryStorageAdapter {
    constructor() {
      /** @type {Map<string,string>} */
      this._map = new Map();
    }
    get(key, fallback = null) {
      if (!this._map.has(key)) return fallback;
      try {
        return JSON.parse(this._map.get(key));
      } catch {
        return fallback;
      }
    }
    set(key, value) {
      try {
        this._map.set(key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    }
    remove(key) {
      this._map.delete(key);
    }
    clear() {
      this._map.clear();
    }
    keys() {
      return Array.from(this._map.keys());
    }
  }

  /**
   * Session model built on top of any StorageAdapter. Owns the persisted shape
   * (bookmarks, marked, answers, weak, stats) so the quiz engine never talks to
   * a storage backend directly — it talks to this.
   */
  class SessionStore {
    /**
     * @param {import('../core/interfaces.js').StorageAdapter} adapter
     */
    constructor(adapter) {
      this.adapter = DAMS.interfaces.StorageAdapter.assert(adapter);
    }

    /** Low-level pass-throughs (used by the UI for theme etc.). */
    get(key, fallback) {
      return this.adapter.get(key, fallback);
    }
    set(key, value) {
      return this.adapter.set(key, value);
    }
    remove(key) {
      this.adapter.remove(key);
    }
    clear() {
      this.adapter.clear();
    }

    /**
     * @param {string} deckId
     * @returns {import('../storage.js').PersistedState}
     */
    loadSession(deckId) {
      const base = this.adapter.get(`session:${deckId}`, null);
      return Object.assign(
        {
          bookmarks: {},
          marked: {},
          answers: {},
          weak: {},
          lastIndex: 0,
          deckId,
          stats: { seen: 0, correct: 0, wrong: 0, startedAt: Date.now(), elapsed: 0 },
        },
        base || {},
      );
    }

    /**
     * @param {string} deckId
     * @param {import('../storage.js').PersistedState} state
     */
    saveSession(deckId, state) {
      this.adapter.set(`session:${deckId}`, state);
    }
  }

  DAMS.adapters = Object.assign(DAMS.adapters || {}, {
    LocalStorageAdapter,
    MemoryStorageAdapter,
    SessionStore,
    NS,
  });
})(window.DAMS = window.DAMS || {});
