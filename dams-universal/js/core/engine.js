'use strict';

/**
 * @file core/engine.js
 * @description Composition root and public API. `DAMS.createEngine(config)` is
 * the single entry point a host application (Kairos AI) links against. It wires
 * the subsystems together with explicit dependency injection and returns a set
 * of protocol-conforming facades — Extractor, QuizEngine factory, SearchEngine
 * factory, FlashcardEngine, StorageAdapter and Exporter — none of which reach
 * for global state. Swap the storage adapter (or any collaborator) via `config`
 * to run headless, in tests, or behind an iOS/WKWebView bridge.
 *
 * The standalone UI (app.js) also builds itself on top of an engine instance,
 * so there is exactly one wiring path and no duplicated coupling.
 */

;(function (DAMS) {
  /**
   * @typedef {Object} EngineConfig
   * @property {import('./interfaces.js').StorageAdapter} [storage]
   *   Persistence backend. Defaults to LocalStorageAdapter in a browser.
   * @property {Object} [parserDeps] injected parser collaborators (see parser.js)
   */

  /**
   * Create a fully-wired engine instance.
   * @param {EngineConfig} [config]
   * @returns {{
   *   storage: import('./interfaces.js').StorageAdapter,
   *   sessions: import('../adapters/storage.adapter.js').SessionStore,
   *   extractor: import('./interfaces.js').Extractor,
   *   createQuiz: (questions:any[], deckId?:string)=>any,
   *   createSearch: (questions:any[])=>import('./interfaces.js').SearchEngine,
   *   flashcards: import('./interfaces.js').FlashcardEngine,
   *   exporter: import('./interfaces.js').Exporter,
   *   deckIdFor: Function,
   *   version: string,
   * }}
   */
  function createEngine(config = {}) {
    const I = DAMS.interfaces;
    const { LocalStorageAdapter, MemoryStorageAdapter, SessionStore } = DAMS.adapters;

    // --- Storage (injected, protocol-checked) ------------------------------
    const storage = config.storage
      ? I.StorageAdapter.assert(config.storage)
      : hasLocalStorage()
        ? new LocalStorageAdapter()
        : new MemoryStorageAdapter();
    const sessions = new SessionStore(storage);

    // --- Extractor facade --------------------------------------------------
    /** @type {import('./interfaces.js').Extractor} */
    const extractor = {
      /**
       * Extract from a File, a raw HTML string, or a pre-loaded LoadedFile.
       * @param {File|string|object} input
       * @param {Function} [onProgress]
       * @returns {Promise<object>}
       */
      async extract(input, onProgress) {
        const loaded = await toLoadedFile(input);
        return DAMS.parser.extract(loaded, onProgress || noop, config.parserDeps || {});
      },
      /**
       * Extract from a raw HTML string with an explicit name.
       * @param {string} rawHtml @param {string} [name] @param {Function} [onProgress]
       */
      async extractFromHtml(rawHtml, name = 'inline.html', onProgress) {
        const loaded = DAMS.loader.parseHtml(name, rawHtml);
        return DAMS.parser.extract(loaded, onProgress || noop, config.parserDeps || {});
      },
    };
    I.Extractor.assert(extractor);

    // --- Quiz engine factory ----------------------------------------------
    /**
     * @param {any[]} questions @param {string} [deckId]
     * @returns {import('./interfaces.js').QuizEngine}
     */
    const createQuiz = (questions, deckId) => {
      const id = deckId || DAMS.quiz.deckIdFor(questions, 'deck');
      const quiz = new DAMS.quiz.Quiz(questions, id, { storage: sessions });
      return I.QuizEngine.assert(quiz);
    };

    // --- Search engine factory --------------------------------------------
    /**
     * @param {any[]} questions @returns {import('./interfaces.js').SearchEngine}
     */
    const createSearch = (questions) => I.SearchEngine.assert(new DAMS.search.SearchIndex(questions));

    // --- Flashcard engine facade ------------------------------------------
    /** @type {import('./interfaces.js').FlashcardEngine} */
    const flashcards = {
      build: DAMS.anki.buildCards,
      toTSV: DAMS.anki.toTSV,
      toCSV: DAMS.anki.toCSV,
      toJSON: DAMS.anki.toJSON,
    };
    I.FlashcardEngine.assert(flashcards);

    // --- Exporter facade (pure serializers) --------------------------------
    /** @type {import('./interfaces.js').Exporter} */
    const exporter = {
      universalJSON: DAMS.exporter.toUniversalJSON,
      anki: DAMS.exporter.ankiArtifact,
      session: DAMS.exporter.sessionArtifact,
      parseSession: DAMS.exporter.parseSession,
    };
    I.Exporter.assert(exporter);

    return {
      storage,
      sessions,
      extractor,
      createQuiz,
      createSearch,
      flashcards,
      exporter,
      deckIdFor: DAMS.quiz.deckIdFor,
      version: DAMS.VERSION || '1.0.0',
    };
  }

  /** @returns {boolean} */
  function hasLocalStorage() {
    try {
      return typeof localStorage !== 'undefined' && localStorage !== null;
    } catch {
      return false;
    }
  }

  /**
   * Normalize any accepted input into a LoadedFile.
   * @param {File|string|object} input
   * @returns {Promise<object>}
   */
  async function toLoadedFile(input) {
    if (input && typeof input === 'object' && 'scripts' in input && 'raw' in input) return input; // already LoadedFile
    if (typeof Blob !== 'undefined' && input instanceof Blob) return DAMS.loader.loadFile(input);
    if (typeof input === 'string') return DAMS.loader.parseHtml('inline.html', input);
    throw new TypeError('createEngine.extract: unsupported input type');
  }

  function noop() {}

  DAMS.VERSION = '1.0.0';
  DAMS.createEngine = createEngine;
})(window.DAMS = window.DAMS || {});
