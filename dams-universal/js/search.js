'use strict';

/**
 * @file search.js
 * @description Lightweight, instant, offline full-text search over the question
 * deck. Builds a tokenized index across question text, options, correct answer,
 * explanation and tags, then ranks matches by field-weighted term frequency.
 */

;(function (DAMS) {
  const { stripHtml } = DAMS.utils;

  class SearchIndex {
    /**
     * @param {import('./quiz.js').Question[]} questions
     */
    constructor(questions) {
      this.questions = questions;
      this.entries = questions.map((q, idx) => ({
        idx,
        q: (q.question || '').toLowerCase(),
        opts: q.options.map((o) => o.text).join(' ').toLowerCase(),
        ans: (q.correctAnswer >= 0 ? q.options[q.correctAnswer]?.text || '' : '').toLowerCase(),
        exp: stripHtml(q.explanation || '').toLowerCase(),
        tags: (q.tags || []).join(' ').toLowerCase(),
      }));
    }

    /**
     * Run a query.
     * @param {string} query @param {number} [limit=100]
     * @returns {{ idx:number, score:number, question:import('./quiz.js').Question }[]}
     */
    search(query, limit = 100) {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      const terms = q.split(/\s+/).filter(Boolean);
      const results = [];
      for (const e of this.entries) {
        let score = 0;
        for (const term of terms) {
          if (e.q.includes(term)) score += 5;
          if (e.ans.includes(term)) score += 4;
          if (e.opts.includes(term)) score += 3;
          if (e.tags.includes(term)) score += 3;
          if (e.exp.includes(term)) score += 1;
        }
        const allMatch = terms.every(
          (t) => e.q.includes(t) || e.opts.includes(t) || e.ans.includes(t) || e.exp.includes(t) || e.tags.includes(t),
        );
        if (allMatch && score > 0) results.push({ idx: e.idx, score, question: this.questions[e.idx] });
      }
      results.sort((a, b) => b.score - a.score);
      return results.slice(0, limit);
    }
  }

  DAMS.search = { SearchIndex };
})(window.DAMS = window.DAMS || {});
