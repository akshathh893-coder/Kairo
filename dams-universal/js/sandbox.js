'use strict';

/**
 * @file sandbox.js
 * @description Executes the DAMS file's inline scripts inside an isolated blob
 * iframe with heavy instrumentation installed BEFORE any DAMS code runs, then
 * harvests discovered question banks and posts them back to the parent via
 * `postMessage`. Using postMessage (instead of reading `iframe.contentWindow`
 * directly) keeps extraction working even when the page is opened from disk
 * (`file://`), where the parent and the blob iframe are cross-origin opaque
 * origins and direct property access would throw.
 *
 * Runtime strategies implemented by the injected instrumentation:
 *   - Monkey-patch Array.prototype.push        (Strategy 7)
 *   - Monkey-patch JSON.parse                  (Strategy 9)
 *   - Monkey-patch fetch / XMLHttpRequest      (Strategy 8)
 *   - Hook Object.defineProperty               (Strategy 10)
 *   - Snapshot new global assignments          (Strategy 5)
 *   - MutationObserver over the DOM            (Strategy 6)
 *   - Function-result capture helper           (Strategy 4)
 *   - Recursive scan of every global + buffer  (Strategies 1 & 3)
 *
 * The instrumentation runs *inside* the iframe, so it is authored as a plain
 * self-contained function serialized via `.toString()`.
 */

;(function (DAMS) {
  /**
   * Instrumentation + harvester installed inside the sandbox. It receives a
   * one-time `NONCE` (spliced in at build time) used to tag its postMessage so
   * the parent can trust the payload. Must not reference any outer scope.
   * @param {string} NONCE
   */
  function INSTRUMENTATION(NONCE) {
    const W = window;
    const cap = {
      pushes: [], jsonParses: [], fetches: [], defineProps: [],
      funcResults: [], domSnapshots: [], errors: [], log: [],
    };
    W.__DAMS_CAPTURE__ = cap;

    const QKEYS = [
      'question', 'text', 'raw_text', 'rawtext', 'stem', 'title', 'body',
      'options', 'choices', 'opts', 'answers',
      'correct', 'answer', 'correct_answer', 'correctanswer', 'correctindex',
      'correct_option', 'ans', 'explanation', 'solution', 'rationale',
    ];
    const OPT = ['options', 'choices', 'opts', 'answers'];
    const COR = ['correct', 'answer', 'correct_answer', 'correctanswer', 'correctindex', 'correct_option', 'ans', 'correctans'];

    const scoreQuestion = (o) => {
      if (!o || typeof o !== 'object' || Array.isArray(o)) return 0;
      const keys = Object.keys(o).map((k) => k.toLowerCase());
      let s = 0;
      const has = (l) => l.some((k) => keys.includes(k));
      if (has(['question', 'text', 'raw_text', 'rawtext', 'stem', 'title', 'body'])) s += 35;
      if (has(OPT)) s += 30;
      if (has(COR)) s += 25;
      if (has(['explanation', 'solution', 'rationale'])) s += 10;
      if (keys.includes('type') && keys.length <= 2) s -= 20;
      return Math.max(0, s);
    };
    const scoreArray = (a) => {
      if (!Array.isArray(a) || a.length === 0) return { isBank: false, score: 0, count: 0 };
      let hits = 0, sum = 0;
      const sample = a.slice(0, Math.min(a.length, 50));
      for (const it of sample) { const sc = scoreQuestion(it); if (sc >= 45) hits++; sum += sc; }
      const ratio = hits / sample.length, avg = sum / sample.length;
      const isBank = ratio >= 0.5 && avg >= 40;
      const score = isBank ? Math.round(avg * ratio * (1 + Math.log10(a.length + 1))) : 0;
      return { isBank, score, count: a.length };
    };
    const looksLikeQuestion = (o) => scoreQuestion(o) >= 45;
    const looksLikeArray = (a) => Array.isArray(a) && a.length > 0 && a.some((x) => scoreQuestion(x) >= 45);

    // ---- Strategy 7: Array.prototype.push ----------------------------------
    // `suspend` guards against re-entrancy: without it, appending to cap.pushes
    // (or our own internal pushes during harvest) would re-trigger the hook and
    // run away. We also append with the ORIGINAL push, never the patched one.
    let suspend = false;
    const realPush = Array.prototype.push;
    Array.prototype.push = function (...items) {
      if (!suspend) {
        try {
          for (const it of items) if (looksLikeQuestion(it) && cap.pushes.length < 200000) realPush.call(cap.pushes, it);
        } catch { /* never break push */ }
      }
      return realPush.apply(this, items);
    };

    // ---- Strategy 9: JSON.parse --------------------------------------------
    const realParse = JSON.parse;
    JSON.parse = function (text, reviver) {
      const out = realParse.call(JSON, text, reviver);
      try {
        if (looksLikeArray(out) || looksLikeQuestion(out)) cap.jsonParses.push(out);
        else if (out && typeof out === 'object') {
          for (const k of Object.keys(out)) if (looksLikeArray(out[k])) { cap.jsonParses.push(out[k]); break; }
        }
      } catch { /* noop */ }
      return out;
    };

    // ---- Strategy 8: fetch + XHR -------------------------------------------
    if (typeof W.fetch === 'function') {
      const realFetch = W.fetch.bind(W);
      W.fetch = function (...args) {
        return realFetch(...args).then((res) => {
          try {
            res.clone().text().then((t) => {
              try { cap.fetches.push(JSON.parse(t)); } catch { /* not json */ }
            }).catch(() => {});
          } catch { /* noop */ }
          return res;
        });
      };
    }
    try {
      const RX = W.XMLHttpRequest;
      if (RX) {
        const open = RX.prototype.open, send = RX.prototype.send;
        RX.prototype.open = function (...a) { this.__u = a[1]; return open.apply(this, a); };
        RX.prototype.send = function (...a) {
          this.addEventListener('load', () => { try { cap.fetches.push(JSON.parse(this.responseText)); } catch { /* noop */ } });
          return send.apply(this, a);
        };
      }
    } catch { /* noop */ }

    // ---- Strategy 10: Object.defineProperty --------------------------------
    const realDefine = Object.defineProperty;
    Object.defineProperty = function (obj, prop, desc) {
      try {
        const v = desc && 'value' in desc ? desc.value : undefined;
        if (looksLikeArray(v) || looksLikeQuestion(v)) cap.defineProps.push(v);
      } catch { /* noop */ }
      return realDefine.call(Object, obj, prop, desc);
    };

    // ---- Strategy 5: baseline global keys ----------------------------------
    try { W.__DAMS_baseline = new Set(Object.getOwnPropertyNames(W)); } catch { W.__DAMS_baseline = new Set(); }

    // ---- Strategy 4: function-result capture helper ------------------------
    W.__DAMS_captureValue = function (v) {
      try { if (looksLikeArray(v) || looksLikeQuestion(v)) cap.funcResults.push(v); } catch { /* noop */ }
    };

    // ---- Strategy 6: MutationObserver --------------------------------------
    try {
      const grab = () => {
        document.querySelectorAll('[class*="question"],[class*="quiz"],[id*="question"],[data-question]').forEach((n) => {
          const t = (n.textContent || '').trim();
          if (t.length > 20 && cap.domSnapshots.length < 5000) cap.domSnapshots.push(t);
        });
      };
      new MutationObserver(grab).observe(document.documentElement, { childList: true, subtree: true });
      W.__DAMS_grabDom = grab;
    } catch { /* noop */ }

    // Error capture so a broken DAMS script never aborts the whole run.
    W.addEventListener('error', (e) => { try { cap.errors.push(String(e.message || e.error || e)); } catch { /* noop */ } });
    W.onerror = function (m) { try { cap.errors.push(String(m)); } catch { /* noop */ } return true; };

    // ---- JSON-safe deep clone (bounded) for transfer -----------------------
    const sanitize = (val, depth, budget) => {
      if (depth > 25 || budget.n > 400000) return null;
      if (val == null) return val;
      const t = typeof val;
      if (t === 'number' || t === 'boolean' || t === 'string') return val;
      if (t === 'function' || t === 'symbol') return undefined;
      budget.n++;
      if (Array.isArray(val)) {
        const out = [];
        for (let i = 0; i < val.length && i < 100000; i++) {
          const c = sanitize(val[i], depth + 1, budget);
          if (c !== undefined) out.push(c);
        }
        return out;
      }
      if (val instanceof Map) { const o = {}; for (const [k, v] of val) o[String(k)] = sanitize(v, depth + 1, budget); return o; }
      if (val instanceof Set) return Array.from(val).map((v) => sanitize(v, depth + 1, budget));
      if (t === 'object') {
        if (val.nodeType || val === W || val === document) return undefined;
        const o = {};
        let keys;
        try { keys = Object.keys(val); } catch { return undefined; }
        for (const k of keys.slice(0, 200)) {
          let cv;
          try { cv = sanitize(val[k], depth + 1, budget); } catch { continue; }
          if (cv !== undefined) o[k] = cv;
        }
        return o;
      }
      return undefined;
    };

    // ---- Recursive discovery (Strategies 1 & 3) + buffer sweep -------------
    const harvest = () => {
      // Suspend push capture so discovery/sanitization work below is not
      // itself captured. Re-enabled after harvest so a later async bank build
      // is still caught by the second (900ms) harvest pass.
      suspend = true;
      try { W.__DAMS_grabDom && W.__DAMS_grabDom(); } catch { /* noop */ }
      const banks = [];
      const seen = new WeakSet();
      const arrayStats = [];
      const consider = (arr, source) => {
        if (!Array.isArray(arr) || seen.has(arr)) return;
        seen.add(arr);
        const info = scoreArray(arr);
        arrayStats.push({ path: source, length: arr.length, score: info.score, isBank: info.isBank });
        if (info.isBank) banks.push({ arr, score: info.score, count: info.count, source });
      };
      const walk = (root, label, depth, count) => {
        if (!root || typeof root !== 'object' || depth > 12 || count.n > 200000) return;
        if (seen.has(root) && !Array.isArray(root)) return;
        count.n++;
        if (Array.isArray(root)) { consider(root, label); return; }
        let keys;
        try { keys = Object.keys(root); } catch { return; }
        for (const k of keys) {
          let v;
          try { v = root[k]; } catch { continue; }
          if (Array.isArray(v)) consider(v, `${label}.${k}`);
          else if (v && typeof v === 'object') walk(v, `${label}.${k}`, depth + 1, count);
        }
      };

      // Globals diff.
      let globalKeys = [];
      try {
        const base = W.__DAMS_baseline || new Set();
        globalKeys = Object.getOwnPropertyNames(W).filter((k) => !base.has(k) && !k.startsWith('__DAMS'));
      } catch { /* noop */ }
      for (const key of globalKeys) {
        let v;
        try { v = W[key]; } catch { continue; }
        if (v == null) continue;
        if (Array.isArray(v)) consider(v, `window.${key}`);
        else if (typeof v === 'object') walk(v, `window.${key}`, 0, { n: 0 });
      }

      // Capture buffers.
      if (cap.pushes.length) consider(cap.pushes, 'capture.pushes');
      for (const [name, buf] of [['jsonParses', cap.jsonParses], ['fetches', cap.fetches], ['defineProps', cap.defineProps], ['funcResults', cap.funcResults]]) {
        for (const entry of buf) {
          if (Array.isArray(entry)) consider(entry, `capture.${name}[]`);
          else if (entry && typeof entry === 'object') walk(entry, `capture.${name}`, 0, { n: 0 });
        }
      }

      banks.sort((a, b) => b.score - a.score || b.count - a.count);
      const top = banks.slice(0, 8).map((b) => ({
        data: sanitize(b.arr, 0, { n: 0 }),
        score: b.score, count: b.count, source: b.source,
      }));
      arrayStats.sort((a, b) => b.length - a.length);

      const debug = {
        globals: globalKeys.slice(0, 500),
        captureCounts: {
          pushes: cap.pushes.length, jsonParses: cap.jsonParses.length, fetches: cap.fetches.length,
          defineProps: cap.defineProps.length, funcResults: cap.funcResults.length, domSnapshots: cap.domSnapshots.length,
        },
        largestArrays: arrayStats.slice(0, 15),
        errors: cap.errors.slice(0, 100),
      };

      suspend = false; // resume capture for any later async bank construction

      try {
        parent.postMessage({ __dams: NONCE, banks: top, debug }, '*');
      } catch (e) {
        try { parent.postMessage({ __dams: NONCE, banks: [], debug: { errors: ['postMessage failed: ' + e.message] } }, '*'); } catch { /* noop */ }
      }
    };

    W.__DAMS_harvest = harvest;
    W.addEventListener('load', () => setTimeout(harvest, 60));
    // Second, later harvest to catch async bank construction.
    setTimeout(harvest, 900);
  }

  /**
   * Escape a closing-script-tag sequence inside injected code.
   * @param {string} code @returns {string}
   */
  function wrapScript(code) {
    // Escape sequences that can break out of or confuse a <script> block when
    // the sandbox HTML is parsed: closing tag and HTML comment open.
    return code
      .replace(/<\/script>/gi, '<\\/script>')
      .replace(/<!--/g, '<\\!--');
  }

  /**
   * Build the sandbox HTML document: instrumentation first, DAMS body + scripts
   * next, each script guarded so a throw does not abort subsequent scripts.
   * @param {import('./loader.js').LoadedFile} file @param {string} nonce @returns {string}
   */
  function buildSandboxHtml(file, nonce) {
    const instr = `<script>(${INSTRUMENTATION.toString()})(${JSON.stringify(nonce)});<\/script>`;

    const bodyClone = file.doc.body ? file.doc.body.cloneNode(true) : null;
    if (bodyClone) bodyClone.querySelectorAll('script').forEach((s) => s.remove());
    const bodyHtml = bodyClone ? bodyClone.innerHTML : '';

    const inlineScripts = file.scripts
      .filter((s) => s.kind === 'inline' && s.code.trim())
      .filter((s) => /javascript|module|text\/js/i.test(s.type) || s.type === 'text/javascript' || s.type === '')
      .map((s, i) => {
        // ES module scripts must be emitted as real modules: their top-level
        // import/export can't be wrapped in try/catch (that would be a parse
        // error), and injecting them as classic scripts makes module-based DAMS
        // quizzes fail to execute entirely. Modules don't expose top-level
        // globals, but the runtime hooks (push/JSON.parse/defineProperty) still
        // fire and the static AST scan covers the rest; window.onerror captures
        // any load failure.
        if (/\bmodule\b/i.test(s.type)) {
          return `<script type="module">${wrapScript(s.code)}<\/script>`;
        }
        const safe = `try{\n${s.code}\n}catch(__e){try{window.__DAMS_CAPTURE__.errors.push('script#${i}: '+(__e&&__e.message||__e));}catch(_){}}\n//# sourceURL=dams-script-${i}.js`;
        return `<script>${wrapScript(safe)}<\/script>`;
      })
      .join('\n');

    const jsonBlocks = file.scripts
      .filter((s) => /json/i.test(s.type) && s.code.trim())
      .map(
        (s, i) =>
          `<script>try{window.__DAMS_JSON_${i}=JSON.parse(${JSON.stringify(s.code)});window.__DAMS_captureValue&&window.__DAMS_captureValue(window.__DAMS_JSON_${i});}catch(e){}<\/script>`,
      )
      .join('\n');

    return `<!doctype html><html><head><meta charset="utf-8">${instr}</head><body>${bodyHtml}\n${inlineScripts}\n${jsonBlocks}</body></html>`;
  }

  /**
   * @typedef {Object} SandboxResult
   * @property {Array<{data:any[], score:number, count:number, source:string}>} banks
   * @property {Object} debug
   */

  /**
   * Execute a loaded DAMS file in the instrumented sandbox and return the banks
   * it discovered (already JSON-safe, transferred via postMessage).
   * @param {import('./loader.js').LoadedFile} file
   * @param {(msg: string) => void} [onLog]
   * @param {number} [timeoutMs=4000]
   * @returns {Promise<SandboxResult>}
   */
  function runInSandbox(file, onLog = () => {}, timeoutMs = 4000) {
    return new Promise((resolve) => {
      const nonce = 'dams_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      const html = buildSandboxHtml(file, nonce);
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);

      const iframe = document.createElement('iframe');
      iframe.setAttribute('aria-hidden', 'true');
      // `allow-scripts` (without allow-same-origin) runs the DAMS code in a
      // unique opaque origin: it cannot read the app's DOM, cookies or
      // localStorage. We never touch contentWindow directly — results come back
      // exclusively through postMessage — so full isolation costs us nothing.
      iframe.setAttribute('sandbox', 'allow-scripts');
      iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;left:-9999px;top:-9999px';

      let settled = false;
      /** @type {SandboxResult} */
      let best = { banks: [], debug: {} };
      /** @type {ReturnType<typeof setTimeout>|null} */
      let earlyTimer = null;

      const cleanup = () => {
        window.removeEventListener('message', onMessage);
        if (earlyTimer !== null) clearTimeout(earlyTimer);
        try { iframe.remove(); } catch { /* noop */ }
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        onLog(`sandbox: ${best.banks.length} bank(s), ${(best.debug.captureCounts?.pushes) || 0} pushes captured`);
        cleanup();
        resolve(best);
      };

      const onMessage = (ev) => {
        const d = ev.data;
        if (!d || d.__dams !== nonce) return;
        // Keep the richest payload (later harvest may be more complete).
        const totalNew = (d.banks || []).reduce((s, b) => s + (b.count || 0), 0);
        const totalOld = (best.banks || []).reduce((s, b) => s + (b.count || 0), 0);
        if (!best.banks.length || totalNew >= totalOld) best = { banks: d.banks || [], debug: d.debug || {} };
        // Fast-resolve 150ms after a harvest — but only once we actually have
        // banks. An empty first harvest (a bank built asynchronously) must not
        // trigger early resolution, or the later 900ms harvest is missed; in
        // that case we keep waiting for it (or the full-timeout fallback).
        if (best.banks.length) {
          if (earlyTimer !== null) clearTimeout(earlyTimer);
          earlyTimer = setTimeout(finish, 150);
        }
      };
      window.addEventListener('message', onMessage);

      iframe.addEventListener('error', () => onLog('sandbox: iframe error'));
      // Fallback: resolve after the full timeout if no harvest ever arrives.
      setTimeout(finish, timeoutMs);

      iframe.src = url;
      document.body.appendChild(iframe);
    });
  }

  DAMS.sandbox = { runInSandbox };
})(window.DAMS = window.DAMS || {});
