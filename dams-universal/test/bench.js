'use strict';

/**
 * @file test/bench.js
 * @description Performance benchmarks, stress tests and memory profiling for the
 * subsystems that dominate cost at scale: normalization, search indexing +
 * querying, quiz construction/answering, and export serialization. Runs the deck
 * sizes required by the stabilization plan — 10, 100, 1000, 10000 — reports
 * timings and JS-heap deltas (Chromium `performance.memory`), and asserts the
 * pipeline stays within loose sanity budgets so regressions surface in CI.
 *
 * Results are rendered to the DOM and exposed on `window.__BENCH_RESULTS__`.
 */

;(function (DAMS) {
  const SIZES = [10, 100, 1000, 10000];

  /**
   * Generate a synthetic raw deck of `n` heterogeneous questions (mixing field
   * shapes and answer encodings so normalization does real work).
   * @param {number} n @returns {any[]}
   */
  function generateDeck(n) {
    const deck = new Array(n);
    for (let i = 0; i < n; i++) {
      const mod = i % 4;
      if (mod === 0) {
        deck[i] = {
          question: `Question number ${i}: which option is correct for item ${i}?`,
          options: [`Option A ${i}`, `Option B ${i}`, `Option C ${i}`, `Option D ${i}`],
          correct: i % 4,
          explanation: `Because option ${(i % 4) + 1} is the established answer for ${i}.`,
          tags: ['bench', `topic-${i % 10}`],
        };
      } else if (mod === 1) {
        deck[i] = {
          stem: `Stem ${i}: pick the right choice.`,
          choices: [`c1-${i}`, `c2-${i}`, `c3-${i}`],
          answer: 'ABC'[i % 3],
          solution: `Solution text for ${i}.`,
          subject: `subject-${i % 8}`,
        };
      } else if (mod === 2) {
        deck[i] = {
          text: `Text ${i} with keyword marker${i % 50 === 0 ? ' rareword' : ''}.`,
          opts: [
            { text: `x-${i}`, correct: false },
            { text: `y-${i}`, correct: true },
            { text: `z-${i}`, correct: false },
          ],
          rationale: `Rationale ${i}.`,
          topic: `topic-${i % 10}`,
        };
      } else {
        deck[i] = {
          raw_text: `Raw ${i}?`,
          answers: [`a-${i}`, `b-${i}`],
          correct_answer: `b-${i}`,
          desc: `desc ${i}`,
          category: `cat-${i % 6}`,
        };
      }
    }
    return deck;
  }

  /** High-resolution timer. @param {()=>void} fn @returns {number} ms */
  function time(fn) {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  }

  /** @returns {number|null} used JS heap bytes, if the browser exposes it */
  function heap() {
    return performance.memory ? performance.memory.usedJSHeapSize : null;
  }

  /** Force GC if exposed (Chromium started with --js-flags=--expose-gc). */
  function gc() {
    try {
      if (window.gc) window.gc();
    } catch {
      /* noop */
    }
  }

  async function runAll() {
    const { MemoryStorageAdapter } = DAMS.adapters;
    const engine = DAMS.createEngine({ storage: new MemoryStorageAdapter() });
    const rows = [];
    const failures = [];

    for (const n of SIZES) {
      gc();
      const heapBefore = heap();

      const raw = generateDeck(n);

      let normalized;
      const tNorm = time(() => {
        normalized = DAMS.normalizer.normalizeBank(raw).questions;
      });

      // Sanity: normalization should preserve count for unique synthetic items.
      if (normalized.length !== n) {
        failures.push(`normalize(${n}) produced ${normalized.length} (expected ${n})`);
      }

      let search;
      const tIndex = time(() => {
        search = engine.createSearch(normalized);
      });
      const tQuery = time(() => {
        for (let k = 0; k < 20; k++) search.search('option rareword topic-' + (k % 10));
      });

      let quiz;
      const tQuiz = time(() => {
        quiz = engine.createQuiz(normalized, `bench-${n}`);
      });
      const answerLimit = Math.min(n, 2000); // cap answering work on the huge deck

      // answerMs: realistic path (each answer persists the session).
      const tAnswer = time(() => {
        for (let k = 0; k < answerLimit; k++) {
          quiz.answer(k % 3);
          quiz.next();
        }
      });

      // answerOpMs: the answer() bookkeeping in isolation (no persistence), to
      // show the aggregate counters make the operation itself O(1). The residual
      // in answerMs is the durability write (full-state JSON serialization).
      const noopStore = {
        loadSession: () => ({ bookmarks: {}, marked: {}, answers: {}, weak: {}, lastIndex: 0, deckId: 'x', stats: { seen: 0, correct: 0, wrong: 0, startedAt: 0, elapsed: 0 } }),
        saveSession() {},
      };
      const quizOp = new DAMS.quiz.Quiz(normalized, `bench-op-${n}`, { storage: noopStore });
      const tAnswerOp = time(() => {
        for (let k = 0; k < answerLimit; k++) {
          quizOp.answer(k % 3);
          quizOp.next();
        }
      });

      let json;
      const tExport = time(() => {
        json = engine.exporter.universalJSON(normalized);
      });
      const bytes = json.length;

      gc();
      const heapAfter = heap();
      const heapDelta = heapBefore != null && heapAfter != null ? heapAfter - heapBefore : null;

      rows.push({
        n,
        normalizeMs: round(tNorm),
        indexMs: round(tIndex),
        query20Ms: round(tQuery),
        quizBuildMs: round(tQuiz),
        answerMs: round(tAnswer),
        answerOpMs: round(tAnswerOp),
        exportMs: round(tExport),
        jsonKB: Math.round(bytes / 1024),
        heapDeltaMB: heapDelta != null ? round(heapDelta / 1048576) : null,
      });
    }

    // Loose regression budgets (generous; catch order-of-magnitude regressions).
    const big = rows.find((r) => r.n === 10000);
    if (big) {
      if (big.normalizeMs > 5000) failures.push(`normalize(10000) too slow: ${big.normalizeMs}ms`);
      if (big.indexMs > 5000) failures.push(`index(10000) too slow: ${big.indexMs}ms`);
      if (big.exportMs > 5000) failures.push(`export(10000) too slow: ${big.exportMs}ms`);
    }

    window.__BENCH_RESULTS__ = { rows, failures, memoryProfiled: heap() != null };
    render(rows, failures);
  }

  function round(x) {
    return Math.round(x * 100) / 100;
  }

  function render(rows, failures) {
    const root = document.getElementById('out') || document.body;
    const header = ['n', 'normalizeMs', 'indexMs', 'query20Ms', 'quizBuildMs', 'answerMs', 'answerOpMs', 'exportMs', 'jsonKB', 'heapDeltaMB'];
    const head = '<tr>' + header.map((h) => `<th>${h}</th>`).join('') + '</tr>';
    const body = rows
      .map((r) => '<tr>' + header.map((h) => `<td>${r[h] == null ? '—' : r[h]}</td>`).join('') + '</tr>')
      .join('');
    const status = failures.length ? `<h2 class="fail">${failures.length} budget failure(s)</h2><pre>${failures.join('\n')}</pre>` : '<h2 class="ok">All benchmarks within budget</h2>';
    root.innerHTML = `${status}<table border="1" cellpadding="6" cellspacing="0">${head}${body}</table>
      <p class="muted">${window.__BENCH_RESULTS__.memoryProfiled ? 'Memory profiled via performance.memory.' : 'performance.memory unavailable in this browser; timings only.'}</p>`;
    document.title = `${failures.length ? 'FAIL' : 'OK'} · DAMS bench`;
  }

  DAMS.__runBench = runAll;
  if (/\bauto=1\b/.test(location.search) && /bench/.test(location.pathname)) {
    document.addEventListener('DOMContentLoaded', runAll);
  }
})(window.DAMS = window.DAMS || {});
