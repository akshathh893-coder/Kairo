'use strict';

/**
 * @file storage.js
 * @description Backward-compatibility facade. Historically the app used a single
 * `DAMS.storage.Storage` object; that surface is preserved verbatim, but it is
 * now just a default {@link SessionStore} composed over a
 * {@link LocalStorageAdapter}. New code should depend on the StorageAdapter
 * protocol (and inject an adapter) rather than reaching for this global — see
 * core/engine.js and adapters/storage.adapter.js.
 */

;(function (DAMS) {
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

  const { LocalStorageAdapter, SessionStore } = DAMS.adapters;

  /** Default session store used when no adapter is injected. */
  const Storage = new SessionStore(new LocalStorageAdapter());

  DAMS.storage = { Storage, SessionStore, LocalStorageAdapter };
})(window.DAMS = window.DAMS || {});
