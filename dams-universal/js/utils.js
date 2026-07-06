'use strict';

/**
 * @file utils.js
 * @description Shared, dependency-free helpers used across the DAMS Universal
 * Extractor. Everything here is pure and side-effect free (except DOM helpers)
 * so it can be reused from any module and unit-reasoned about in isolation.
 *
 * The whole app ships as classic scripts (no ES module `import`) so it runs by
 * simply opening index.html from disk — module scripts are blocked on file://
 * by browsers. Each file publishes its API onto the global `DAMS` namespace.
 */

;(function (DAMS) {
  /**
   * A tiny event emitter used to decouple modules (loader -> parser -> app UI).
   */
  class Emitter {
    constructor() {
      /** @type {Map<string, Set<Function>>} */
      this._map = new Map();
    }

    /**
     * Subscribe to an event.
     * @param {string} type
     * @param {(payload: any) => void} fn
     * @returns {() => void} unsubscribe function
     */
    on(type, fn) {
      if (!this._map.has(type)) this._map.set(type, new Set());
      this._map.get(type).add(fn);
      return () => this.off(type, fn);
    }

    /**
     * Unsubscribe a handler.
     * @param {string} type
     * @param {(payload: any) => void} fn
     */
    off(type, fn) {
      this._map.get(type)?.delete(fn);
    }

    /**
     * Emit an event to all subscribers.
     * @param {string} type
     * @param {any} [payload]
     */
    emit(type, payload) {
      this._map.get(type)?.forEach((fn) => {
        try {
          fn(payload);
        } catch (err) {
          console.error('[Emitter] listener error for', type, err);
        }
      });
    }
  }

  /**
   * Query a single element.
   * @param {string} sel
   * @param {ParentNode} [root=document]
   * @returns {HTMLElement|null}
   */
  const $ = (sel, root = document) => /** @type {HTMLElement|null} */ (root.querySelector(sel));

  /**
   * Query all elements as a real array.
   * @param {string} sel
   * @param {ParentNode} [root=document]
   * @returns {HTMLElement[]}
   */
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /**
   * Create an element with attributes and children in one call.
   * @param {string} tag
   * @param {Record<string, any>} [attrs]
   * @param {(Node|string)[]|Node|string} [children]
   * @returns {HTMLElement}
   */
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'html') node.innerHTML = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    const kids = Array.isArray(children) ? children : [children];
    for (const c of kids) {
      if (c == null) continue;
      node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  /**
   * Escape a string for safe HTML text insertion.
   * @param {any} str
   * @returns {string}
   */
  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Strip HTML tags to get plain text (used for search indexing / previews).
   * @param {any} html
   * @returns {string}
   */
  function stripHtml(html) {
    if (html == null) return '';
    const tmp = document.createElement('div');
    tmp.innerHTML = String(html);
    return (tmp.textContent || tmp.innerText || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Deterministic-ish unique id generator.
   * @param {string} [prefix='q']
   * @returns {string}
   */
  function uid(prefix = 'q') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Stable hash (djb2) of a string — used to de-duplicate discovered questions.
   * @param {string} str
   * @returns {string}
   */
  function hash(str) {
    let h = 5381;
    const s = String(str);
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  /**
   * Clamp a number.
   * @param {number} n @param {number} min @param {number} max @returns {number}
   */
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  /**
   * Fisher–Yates shuffle returning a new array.
   * @template T @param {T[]} arr @returns {T[]}
   */
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /**
   * Format milliseconds as mm:ss (or h:mm:ss).
   * @param {number} ms @returns {string}
   */
  function formatTime(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (x) => String(x).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  /**
   * Debounce a function.
   * @template {(...args:any[])=>any} F @param {F} fn @param {number} [wait=200] @returns {F}
   */
  function debounce(fn, wait = 200) {
    let t;
    // @ts-ignore
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  /**
   * Trigger a client-side file download for arbitrary text/binary content.
   * @param {string} filename @param {BlobPart} content @param {string} [mime='text/plain']
   */
  function downloadFile(filename, content, mime = 'text/plain') {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /**
   * Deeply and safely walk an arbitrary value, calling `visit` for every node.
   * Guards against cycles and caps traversal to keep the UI responsive.
   * @param {any} root
   * @param {(value:any, path:string) => void} visit
   * @param {{ maxNodes?: number, maxDepth?: number }} [opts]
   */
  function deepWalk(root, visit, opts = {}) {
    const maxNodes = opts.maxNodes ?? 500000;
    const maxDepth = opts.maxDepth ?? 40;
    const seen = new WeakSet();
    let count = 0;
    const rec = (val, path, depth) => {
      if (count++ > maxNodes || depth > maxDepth) return;
      if (val == null) return;
      const t = typeof val;
      if (t !== 'object' && t !== 'function') return;
      if (seen.has(val)) return;
      try {
        seen.add(val);
      } catch {
        return;
      }
      visit(val, path);
      if (Array.isArray(val)) {
        for (let i = 0; i < val.length; i++) rec(val[i], `${path}[${i}]`, depth + 1);
      } else if (val instanceof Map) {
        let i = 0;
        for (const [, v] of val) rec(v, `${path}.get(${i++})`, depth + 1);
      } else if (val instanceof Set) {
        let i = 0;
        for (const v of val) rec(v, `${path}.item(${i++})`, depth + 1);
      } else if (t === 'object') {
        let keys;
        try {
          keys = Object.keys(val);
        } catch {
          return;
        }
        for (const k of keys) {
          let child;
          try {
            child = val[k];
          } catch {
            continue;
          }
          rec(child, path ? `${path}.${k}` : k, depth + 1);
        }
      }
    };
    rec(root, '', 0);
  }

  /**
   * Safe JSON stringify that tolerates cycles and large graphs.
   * @param {any} value @param {number} [space] @returns {string}
   */
  function safeStringify(value, space) {
    const seen = new WeakSet();
    return JSON.stringify(
      value,
      (_k, v) => {
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[Circular]';
          seen.add(v);
        }
        if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
        if (v instanceof Map) return { __map__: Array.from(v.entries()) };
        if (v instanceof Set) return { __set__: Array.from(v.values()) };
        return v;
      },
      space,
    );
  }

  DAMS.utils = {
    Emitter,
    $,
    $$,
    el,
    escapeHtml,
    stripHtml,
    uid,
    hash,
    clamp,
    shuffle,
    formatTime,
    debounce,
    downloadFile,
    deepWalk,
    safeStringify,
  };
})(window.DAMS = window.DAMS || {});
