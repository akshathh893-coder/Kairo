'use strict';

/**
 * @file parser.js
 * @description Top-level extraction orchestrator. Given a LoadedFile it runs
 * every universal-extraction strategy in order, reporting progress, and merges
 * their results before choosing the strongest question bank. It never gives up
 * after a single strategy: the instrumented sandbox (runtime interception +
 * recursive discovery) and the static AST/tokenizer scan are both attempted.
 *
 * Progress messages mirror the spec's example:
 *   Trying sandbox...
 *   Trying recursive scan / push interception...
 *   Trying AST...
 *   Found 312 questions.
 */

;(function (DAMS) {
  const { runInSandbox } = DAMS.sandbox;
  const { scanObjectLiterals, dedupeCandidates } = DAMS.extractor;
  const { normalizeBank, normalizeImported } = DAMS.normalizer;

  /**
   * @typedef {Object} ExtractionReport
   * @property {import('./quiz.js').Question[]} questions
   * @property {string} strategy
   * @property {Array<{data:any[],score:number,count:number,source:string}>} candidates
   * @property {Object} debug
   * @property {string[]} log
   */

  /**
   * Run the full extraction pipeline.
   * @param {import('./loader.js').LoadedFile} file
   * @param {(msg:string, pct?:number)=>void} [onProgress]
   * @returns {Promise<ExtractionReport>}
   */
  async function extract(file, onProgress = () => {}) {
    const log = [];
    const say = (msg, pct) => {
      log.push(msg);
      onProgress(msg, pct);
    };

    const debug = {
      fileName: file.name,
      fileSize: file.size,
      scriptCount: file.scripts.length,
      globals: [],
      largestArrays: [],
      captureCounts: {},
      errors: [],
      candidates: [],
    };

    if (file.isSessionJson) {
      say('Detected exported session JSON...', 10);
      const { questions } = normalizeImported(file.sessionData);
      say(`Found ${questions.length} questions.`, 100);
      return { questions, strategy: 'session-import', candidates: [], debug, log };
    }

    /** @type {Array<{data:any[],score:number,count:number,source:string}>} */
    let candidates = [];

    // ---- Strategies 1,3,4,5,6,7,8,9,10: instrumented sandbox ----------------
    say('Trying sandbox execution...', 15);
    try {
      const result = await runInSandbox(file, (m) => say('  ' + m));
      candidates = candidates.concat(result.banks || []);
      Object.assign(debug, {
        globals: result.debug.globals || [],
        largestArrays: result.debug.largestArrays || [],
        captureCounts: result.debug.captureCounts || {},
        errors: (result.debug.errors || []).slice(0, 100),
      });
      say(`Trying recursive scan + push/JSON/fetch interception... (${(result.banks || []).length} bank(s))`, 50);
    } catch (err) {
      say('  sandbox failed: ' + (err && err.message ? err.message : String(err)));
      debug.errors.push('sandbox: ' + (err && err.message));
    }

    // ---- Strategy 2: static AST / tokenizer scan ----------------------------
    // Always run: catches const/let/closure/IIFE banks the sandbox global
    // snapshot cannot see.
    say('Trying AST / static literal scan...', 72);
    for (const s of file.scripts) {
      if (s.kind !== 'inline' || !s.code || s.code.length < 40) continue;
      try {
        const banks = scanObjectLiterals(s.code, (m) => log.push('  ' + m));
        candidates = candidates.concat(banks);
      } catch (e) {
        log.push('  ast error: ' + (e && e.message));
      }
    }

    candidates = dedupeCandidates(candidates.sort((a, b) => b.score - a.score || b.count - a.count));
    debug.candidates = candidates.slice(0, 20).map((c) => ({ score: c.score, count: c.count, source: c.source }));

    // Merge every distinct high-confidence bank and de-duplicate by content.
    // Real DAMS files carry a single bank (all strategies converge on it and
    // dedupe to one candidate); files that expose several banks — or the same
    // bank via different strategies — are unioned so no question is dropped.
    const best = candidates[0];
    let questions = [];
    let strategy = 'none';
    if (best) {
      questions = mergeBanks(candidates).questions;
      strategy = candidates.length > 1 ? `merged (${best.source} +${candidates.length - 1})` : best.source;
    }

    if (questions.length > 0) say(`Found ${questions.length} questions.`, 100);
    else say('No question bank detected. See debug panel for discovered arrays.', 100);

    return { questions, strategy, candidates, debug, log };
  }

  /**
   * Merge multiple candidate banks, de-duplicating questions.
   * @param {Array<{data:any[]}>} cands @returns {{ questions: import('./quiz.js').Question[] }}
   */
  function mergeBanks(cands) {
    const combined = [];
    for (const c of cands) combined.push(...c.data);
    return normalizeBank(combined);
  }

  DAMS.parser = { extract };
})(window.DAMS = window.DAMS || {});
