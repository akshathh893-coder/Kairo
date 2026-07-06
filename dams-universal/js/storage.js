'use strict';

/**
 * @file storage.js
 * @description Thin, namespaced wrapper over localStorage that persists quiz
 * state: bookmarks, progress, last question, weak areas and statistics. All
 * reads/writes are defensive so a corrupt or full localStorage never crashes
 * the app.
 */

;(function (DAMS) {
  const NS = 'dams-universal:';

  /**
   * @typedef {Object} PersistedState
   * @property {Record<string, boolean>} bookmarks
   * @property {Record<string, boolean>} marked
   * @property {Record<string, {correct:boolean, chosen:number|null, at:number}>} answers
   * @property {Record<string, number>} weak
   * @property {number} lastIndex
   * @property {string|null} deckId
   * @property {Object} stats
   */

  const Storage = {
    /**
     * @param {string} key @param {any} fallback @returns {any}
     */
    get(key, fallback = null) {
      try {
        const raw = localStorage.getItem(NS + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },

    /**
     * @param {string} key @param {any} value @returns {boolean} success
     */
    set(key, value) {
      try {
        localStorage.setItem(NS + key, JSON.stringify(value));
        return true;
      } catch (err) {
        console.warn('[Storage] set failed', key, err);
        return false;
      }
    },

    /** @param {string} key */
    remove(key) {
      try {
        localStorage.removeItem(NS + key);
      } catch {
        /* noop */
      }
    },

    /** Clear only this app's keys. */
    clear() {
      try {
        Object.keys(localStorage)
          .filter((k) => k.startsWith(NS))
          .forEach((k) => localStorage.removeItem(k));
      } catch {
        /* noop */
      }
    },

    /**
     * Return the full persisted session (stable shape, always populated).
     * @param {string} deckId @returns {PersistedState}
     */
    loadSession(deckId) {
      const base = this.get(`session:${deckId}`, null);
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
    },

    /**
     * Persist a session snapshot.
     * @param {string} deckId @param {PersistedState} state
     */
    saveSession(deckId, state) {
      this.set(`session:${deckId}`, state);
    },
  };

  DAMS.storage = { Storage };
})(window.DAMS = window.DAMS || {});
