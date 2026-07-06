'use strict';

/**
 * @file extractor.js
 * @description Static extraction + scoring primitives shared by the sandbox
 * (runtime discovery) and the parser (AST/static discovery).
 *
 *   - {@link scoreQuestion} / {@link scoreArray} — structural heuristics that
 *     recognize a question bank without knowing any variable names.
 *   - {@link scanObjectLiterals} — a character-level tokenizer that locates
 *     balanced array literals in raw source while correctly skipping strings and
 *     comments (no regex parsing of code), then materializes them with a guarded
 *     evaluator. This is Strategy 2 (AST/static) and catches const/let/closure/
 *     IIFE banks that never touch the global object. If the optional Acorn
 *     vendor bundle is present it is used for precise AST node enumeration.
 *
 * The runtime discovery strategies (1,3,4,5,6,7,8,9,10) run *inside* the sandbox
 * and are implemented in sandbox.js; they reuse the same scoring heuristics,
 * duplicated there in self-contained form because that code is stringified.
 */

;(function (DAMS) {
  /** Field names that identify a question object across DAMS versions. */
  const QUESTION_KEYS = [
    'question', 'text', 'raw_text', 'rawtext', 'stem', 'title', 'body',
    'options', 'choices', 'opts', 'answers',
    'correct', 'answer', 'correct_answer', 'correctanswer', 'correctindex',
    'correct_option', 'ans', 'explanation', 'solution', 'rationale',
  ];

  const OPTION_KEYS = ['options', 'choices', 'opts', 'answers'];
  const CORRECT_KEYS = [
    'correct', 'answer', 'correct_answer', 'correctanswer', 'correctindex',
    'correct_option', 'ans', 'correctans',
  ];

  /**
   * Score how strongly an object resembles a quiz question (0..100).
   * @param {any} o @returns {number}
   */
  function scoreQuestion(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return 0;
    const keys = Object.keys(o).map((k) => k.toLowerCase());
    let score = 0;
    const has = (list) => list.some((k) => keys.includes(k));
    if (has(['question', 'text', 'raw_text', 'rawtext', 'stem', 'title', 'body'])) score += 35;
    if (has(OPTION_KEYS)) score += 30;
    if (has(CORRECT_KEYS)) score += 25;
    if (has(['explanation', 'solution', 'rationale'])) score += 10;
    if (keys.includes('type') && keys.length <= 2) score -= 20;
    return Math.max(0, score);
  }

  /**
   * Is this an array of question-like objects, and how good is it?
   * @param {any} arr @returns {{ isBank: boolean, score: number, count: number }}
   */
  function scoreArray(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return { isBank: false, score: 0, count: 0 };
    let hits = 0;
    let sum = 0;
    const sample = arr.slice(0, Math.min(arr.length, 50));
    for (const item of sample) {
      const s = scoreQuestion(item);
      if (s >= 45) hits++;
      sum += s;
    }
    const ratio = hits / sample.length;
    const avg = sum / sample.length;
    const isBank = ratio >= 0.5 && avg >= 40;
    const score = isBank ? Math.round(avg * ratio * (1 + Math.log10(arr.length + 1))) : 0;
    return { isBank, score, count: arr.length };
  }

  /**
   * Cheap content signature for a single question object (for de-duplication).
   * @param {any} o @returns {string}
   */
  function signature(o) {
    if (!o || typeof o !== 'object') return String(o);
    const k = Object.keys(o).sort().join(',');
    let sample = '';
    for (const key of ['question', 'text', 'stem', 'raw_text']) {
      if (o[key]) {
        sample = String(o[key]).slice(0, 40);
        break;
      }
    }
    return `${k}|${sample}`;
  }

  /**
   * Remove candidates whose content duplicates a higher-ranked one.
   * @template {{data:any[], count:number}} C
   * @param {C[]} cands @returns {C[]}
   */
  function dedupeCandidates(cands) {
    const out = [];
    const sigs = new Set();
    for (const c of cands) {
      const first = c.data[0];
      const last = c.data[c.data.length - 1];
      const sig = `${c.count}:${signature(first)}:${signature(last)}`;
      if (sigs.has(sig)) continue;
      sigs.add(sig);
      out.push(c);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  //  Strategy 2: static object-literal scanning (AST or hand-written tokenizer)
  // -------------------------------------------------------------------------

  /**
   * Build a boolean mask marking which characters of `code` are executable code
   * (1) vs. inside a string, template, or comment (0). This lets bracket
   * matching ignore brackets that live inside string data — the classic reason
   * regex-based extraction fails.
   * @param {string} code @returns {Uint8Array}
   */
  function maskCode(code) {
    const mask = new Uint8Array(code.length);
    let i = 0;
    const n = code.length;
    const S = { CODE: 0, LINE: 1, BLOCK: 2, SQ: 3, DQ: 4, TPL: 5 };
    let state = S.CODE;
    while (i < n) {
      const c = code[i];
      const c2 = code[i + 1];
      switch (state) {
        case S.CODE:
          if (c === '/' && c2 === '/') { state = S.LINE; i += 2; continue; }
          if (c === '/' && c2 === '*') { state = S.BLOCK; i += 2; continue; }
          if (c === "'") { state = S.SQ; i++; continue; }
          if (c === '"') { state = S.DQ; i++; continue; }
          if (c === '`') { state = S.TPL; i++; continue; }
          mask[i] = 1;
          i++;
          break;
        case S.LINE:
          if (c === '\n') state = S.CODE;
          i++;
          break;
        case S.BLOCK:
          if (c === '*' && c2 === '/') { state = S.CODE; i += 2; continue; }
          i++;
          break;
        case S.SQ:
        case S.DQ: {
          const q = state === S.SQ ? "'" : '"';
          if (c === '\\') { i += 2; continue; }
          if (c === q) state = S.CODE;
          i++;
          break;
        }
        case S.TPL:
          if (c === '\\') { i += 2; continue; }
          if (c === '`') state = S.CODE;
          i++;
          break;
        default:
          i++;
      }
    }
    return mask;
  }

  /**
   * Locate balanced array-literal spans in source, honoring the code mask.
   * @param {string} code @param {Uint8Array} mask
   * @returns {Array<{start:number,end:number}>}
   */
  function findArraySpans(code, mask) {
    const spans = [];
    const stack = [];
    for (let i = 0; i < code.length; i++) {
      if (!mask[i]) continue;
      const c = code[i];
      if (c === '[' || c === '{' || c === '(') stack.push({ ch: c, idx: i });
      else if (c === ']' || c === '}' || c === ')') {
        const open = stack.pop();
        if (!open) continue;
        if (open.ch === '[' && c === ']') spans.push({ start: open.idx, end: i });
      }
    }
    return spans;
  }

  /**
   * Guarded evaluation of an extracted literal into real JS values.
   * @param {string} literal @returns {any|null}
   */
  function evalLiteral(literal) {
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('return (' + literal + ');');
      return fn();
    } catch {
      return null;
    }
  }

  /**
   * Static scan of source for question-bank array literals.
   * @param {string} code @param {(msg:string)=>void} [onLog]
   * @returns {Array<{data:any[], score:number, count:number, source:string}>}
   */
  function scanObjectLiterals(code, onLog = () => {}) {
    if (!code || code.length < 30) return [];

    const acorn = /** @type {any} */ (window).acorn;
    if (acorn && typeof acorn.parse === 'function') {
      try {
        return scanWithAcorn(code, acorn, onLog);
      } catch (e) {
        onLog('acorn failed, falling back to tokenizer: ' + (e && e.message));
      }
    }

    const mask = maskCode(code);
    const spans = findArraySpans(code, mask);
    const out = [];
    const seen = new Set();
    spans.sort((a, b) => b.end - b.start - (a.end - a.start));
    let tried = 0;
    for (const span of spans) {
      if (tried > 60) break;
      const text = code.slice(span.start, span.end + 1);
      if (text.length < 60) continue;
      const low = text.toLowerCase();
      const kwHits = QUESTION_KEYS.filter(
        (k) => low.includes('"' + k) || low.includes("'" + k) || low.includes(k + ':') || low.includes(k + '"') || low.includes(k + "'"),
      ).length;
      if (kwHits < 2) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      tried++;
      const val = evalLiteral(text);
      const info = scoreArray(val);
      if (info.isBank) out.push({ data: val, score: info.score, count: info.count, source: 'ast/tokenizer' });
    }
    out.sort((a, b) => b.score - a.score || b.count - a.count);
    onLog(`ast: scanned ${spans.length} array literal(s), ${out.length} bank(s)`);
    return dedupeCandidates(out);
  }

  /**
   * Acorn-backed literal discovery.
   * @param {string} code @param {any} acorn @param {(msg:string)=>void} [onLog]
   * @returns {Array<{data:any[], score:number, count:number, source:string}>}
   */
  function scanWithAcorn(code, acorn, onLog = () => {}) {
    const ast = acorn.parse(code, { ecmaVersion: 'latest', silent: true, ranges: true });
    const ranges = [];
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'ArrayExpression' && Array.isArray(node.elements) && node.elements.length >= 2) {
        ranges.push([node.start, node.end]);
      }
      for (const k of Object.keys(node)) {
        const child = node[k];
        if (Array.isArray(child)) child.forEach(visit);
        else if (child && typeof child.type === 'string') visit(child);
      }
    };
    visit(ast);
    ranges.sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
    const out = [];
    let tried = 0;
    for (const [s, e] of ranges) {
      if (tried > 40) break;
      const text = code.slice(s, e);
      const low = text.toLowerCase();
      if (QUESTION_KEYS.filter((k) => low.includes(k)).length < 2) continue;
      tried++;
      const val = evalLiteral(text);
      const info = scoreArray(val);
      if (info.isBank) out.push({ data: val, score: info.score, count: info.count, source: 'acorn' });
    }
    out.sort((a, b) => b.score - a.score || b.count - a.count);
    onLog(`acorn: ${ranges.length} array node(s), ${out.length} bank(s)`);
    return dedupeCandidates(out);
  }

  DAMS.extractor = {
    QUESTION_KEYS,
    scoreQuestion,
    scoreArray,
    signature,
    dedupeCandidates,
    maskCode,
    scanObjectLiterals,
  };
})(window.DAMS = window.DAMS || {});
