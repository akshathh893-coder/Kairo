'use strict';

/**
 * @file core/interfaces.js
 * @description Public protocol definitions for every subsystem. These are the
 * contracts the host application (Kairos AI) and the standalone UI both depend
 * on — nothing outside a subsystem should reach past these method lists.
 *
 * JavaScript has no native interfaces, so a "protocol" here is:
 *   1. a JSDoc `@typedef` describing the shape (for editor/type tooling), and
 *   2. a runtime method-name list plus {@link Protocol.assert} that verifies an
 *      object satisfies it. This lets every adapter be validated at composition
 *      time and lets tests assert conformance without a type checker.
 *
 * The six required protocols are: Extractor, QuizEngine, SearchEngine,
 * FlashcardEngine, StorageAdapter, Exporter.
 */

;(function (DAMS) {
  /**
   * A named protocol: an object's required method names.
   */
  class Protocol {
    /**
     * @param {string} name
     * @param {string[]} methods required method names
     */
    constructor(name, methods) {
      this.name = name;
      this.methods = methods;
    }

    /**
     * Does `obj` structurally satisfy this protocol?
     * @param {any} obj
     * @returns {boolean}
     */
    isImplementedBy(obj) {
      if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return false;
      return this.methods.every((m) => typeof obj[m] === 'function');
    }

    /**
     * List the methods `obj` is missing to satisfy this protocol.
     * @param {any} obj
     * @returns {string[]}
     */
    missing(obj) {
      if (!obj) return this.methods.slice();
      return this.methods.filter((m) => typeof obj[m] !== 'function');
    }

    /**
     * Assert conformance, throwing a descriptive error otherwise. Returns `obj`
     * so it can be used inline: `const s = Protocol.StorageAdapter.assert(x)`.
     * @template T
     * @param {T} obj
     * @returns {T}
     */
    assert(obj) {
      const miss = this.missing(obj);
      if (miss.length) {
        throw new TypeError(`Object does not satisfy ${this.name}: missing method(s) ${miss.join(', ')}`);
      }
      return obj;
    }
  }

  // ---- The six public protocols -------------------------------------------

  /**
   * @typedef {Object} StorageAdapter  Low-level key/value persistence.
   * @property {(key:string, fallback?:any)=>any} get
   * @property {(key:string, value:any)=>boolean} set
   * @property {(key:string)=>void} remove
   * @property {()=>void} clear
   * @property {()=>string[]} keys
   */
  const StorageAdapter = new Protocol('StorageAdapter', ['get', 'set', 'remove', 'clear', 'keys']);

  /**
   * @typedef {Object} Extractor  Turns a source (File / raw HTML / session) into
   * canonical questions plus a diagnostic report.
   * @property {(input:any, onProgress?:Function)=>Promise<{questions:any[], strategy:string, debug:object, log:string[]}>} extract
   * @property {(rawHtml:string, name?:string, onProgress?:Function)=>Promise<any>} extractFromHtml
   */
  const Extractor = new Protocol('Extractor', ['extract', 'extractFromHtml']);

  /**
   * @typedef {Object} QuizEngine  Stateful quiz session over a deck.
   * @property {()=>any} current
   * @property {()=>void} next
   * @property {()=>void} prev
   * @property {(n:number)=>void} jumpTo
   * @property {(i:number)=>any} answer
   * @property {(f:string)=>void} setFilter
   * @property {()=>object} stats
   * @property {(t:string, fn:Function)=>Function} on
   */
  const QuizEngine = new Protocol('QuizEngine', ['current', 'next', 'prev', 'jumpTo', 'answer', 'setFilter', 'stats', 'on']);

  /**
   * @typedef {Object} SearchEngine  Read-only full-text search over a deck.
   * @property {(query:string, limit?:number)=>Array<{idx:number,score:number,question:any}>} search
   */
  const SearchEngine = new Protocol('SearchEngine', ['search']);

  /**
   * @typedef {Object} FlashcardEngine  Builds/serializes flashcards (Anki).
   * @property {(questions:any[], type?:string)=>any[]} build
   * @property {(cards:any[])=>string} toTSV
   * @property {(cards:any[])=>string} toCSV
   * @property {(cards:any[])=>string} toJSON
   */
  const FlashcardEngine = new Protocol('FlashcardEngine', ['build', 'toTSV', 'toCSV', 'toJSON']);

  /**
   * @typedef {Object} Exporter  Produces portable artifacts from a deck/session.
   * @property {(questions:any[], meta?:object)=>string} universalJSON
   * @property {(questions:any[], opts?:object)=>{filename:string, mime:string, content:string}} anki
   * @property {(quiz:any)=>{filename:string, mime:string, content:string}} session
   * @property {(text:string)=>{questions:any[], state:any}} parseSession
   */
  const Exporter = new Protocol('Exporter', ['universalJSON', 'anki', 'session', 'parseSession']);

  DAMS.interfaces = {
    Protocol,
    StorageAdapter,
    Extractor,
    QuizEngine,
    SearchEngine,
    FlashcardEngine,
    Exporter,
    /** All protocols, keyed by name (handy for tests). */
    all: { StorageAdapter, Extractor, QuizEngine, SearchEngine, FlashcardEngine, Exporter },
  };
})(window.DAMS = window.DAMS || {});
