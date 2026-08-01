'use strict';

/**
 * @file loader.js
 * @description Reads a DAMS HTML file (or previously exported session JSON)
 * entirely in the browser using the File API. It splits the raw HTML into the
 * pieces the parser needs: the document DOM, inline `<script>` bodies, external
 * script URLs, and any inline styles. Nothing here executes user code — that is
 * the sandbox's job.
 */

;(function (DAMS) {
  const { el } = DAMS.utils;

  /**
   * @typedef {Object} ScriptChunk
   * @property {'inline'|'external'} kind
   * @property {string} code
   * @property {string} src
   * @property {string} type
   * @property {number} index
   */

  /**
   * @typedef {Object} LoadedFile
   * @property {string} name
   * @property {number} size
   * @property {string} raw
   * @property {Document} doc
   * @property {ScriptChunk[]} scripts
   * @property {string} bodyHtml
   * @property {boolean} isSessionJson
   * @property {any} [sessionData]
   */

  /**
   * Read a File as UTF-8 text.
   * @param {File} file @returns {Promise<string>}
   */
  function readFileText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(reader.error || new Error('read error'));
      reader.readAsText(file, 'utf-8');
    });
  }

  /**
   * Parse raw HTML text into a structured LoadedFile without executing scripts.
   * @param {string} name @param {string} raw @param {number} [size] @returns {LoadedFile}
   */
  function parseHtml(name, raw, size = raw.length) {
    const trimmed = raw.trimStart();

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const data = JSON.parse(raw);
        if (data && (Array.isArray(data.questions) || Array.isArray(data))) {
          return {
            name,
            size,
            raw,
            doc: document.implementation.createHTMLDocument('empty'),
            scripts: [],
            bodyHtml: '',
            isSessionJson: true,
            sessionData: data,
          };
        }
      } catch {
        /* fall through to HTML parsing */
      }
    }

    const doc = new DOMParser().parseFromString(raw, 'text/html');
    /** @type {ScriptChunk[]} */
    const scripts = [];
    const scriptNodes = Array.from(doc.querySelectorAll('script'));
    scriptNodes.forEach((node, index) => {
      const src = node.getAttribute('src') || '';
      scripts.push({
        kind: src ? 'external' : 'inline',
        code: src ? '' : node.textContent || '',
        src,
        type: node.getAttribute('type') || 'text/javascript',
        index,
      });
    });

    return {
      name,
      size,
      raw,
      doc,
      scripts,
      bodyHtml: doc.body ? doc.body.innerHTML : '',
      isSessionJson: false,
    };
  }

  /**
   * Full pipeline: File -> LoadedFile.
   * @param {File} file @returns {Promise<LoadedFile>}
   */
  async function loadFile(file) {
    const raw = await readFileText(file);
    return parseHtml(file.name, raw, file.size);
  }

  /**
   * Wire a drop zone + file input to a callback.
   * @param {HTMLElement} zone @param {HTMLInputElement} input @param {(file: File) => void} onFile
   */
  function wireDropZone(zone, input, onFile) {
    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    ['dragenter', 'dragover'].forEach((t) =>
      zone.addEventListener(t, (e) => {
        stop(e);
        zone.classList.add('is-dragging');
      }),
    );
    ['dragleave', 'drop'].forEach((t) =>
      zone.addEventListener(t, (e) => {
        stop(e);
        zone.classList.remove('is-dragging');
      }),
    );
    zone.addEventListener('drop', (e) => {
      const dt = /** @type {DragEvent} */ (e).dataTransfer;
      const file = dt?.files?.[0];
      if (file) onFile(file);
    });
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) onFile(file);
      input.value = '';
    });
  }

  /**
   * Collect standalone image URLs referenced in raw HTML (last-resort pool).
   * @param {string} raw @returns {string[]}
   */
  function harvestInlineImages(raw) {
    const found = new Set();
    const tmp = el('div', { html: raw });
    tmp.querySelectorAll('img[src]').forEach((img) => {
      const s = img.getAttribute('src');
      if (s) found.add(s);
    });
    return Array.from(found);
  }

  DAMS.loader = { readFileText, parseHtml, loadFile, wireDropZone, harvestInlineImages };
})(window.DAMS = window.DAMS || {});
