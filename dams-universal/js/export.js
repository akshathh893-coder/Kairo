'use strict';

/**
 * @file export.js
 * @description High-level export/import orchestration. Wraps the Anki builders
 * and produces downloadable artifacts: the universal quiz JSON, Anki decks
 * (TSV/CSV/JSON, basic/cloze/image), and full session snapshots (progress +
 * bookmarks) that can be re-imported later.
 */

;(function (DAMS) {
  const { downloadFile, safeStringify } = DAMS.utils;
  const { buildCards, toTSV, toCSV, toJSON } = DAMS.anki;

  function sanitize(s) {
    return String(s || 'export').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80);
  }

  /**
   * The universal quiz format: `{ meta, questions: [] }`.
   * @param {import('./quiz.js').Question[]} questions @param {Object} [meta] @returns {string}
   */
  function toUniversalJSON(questions, meta = {}) {
    return safeStringify(
      {
        meta: Object.assign(
          { format: 'dams-universal', version: 1, generatedAt: new Date().toISOString(), count: questions.length },
          meta,
        ),
        questions,
      },
      2,
    );
  }

  /**
   * @param {import('./quiz.js').Question[]} questions @param {string} [name] @param {Object} [meta]
   */
  function exportUniversalJSON(questions, name = 'dams-quiz', meta) {
    downloadFile(`${sanitize(name)}.json`, toUniversalJSON(questions, meta), 'application/json');
  }

  /**
   * @param {import('./quiz.js').Question[]} questions
   * @param {{ format?: 'tsv'|'csv'|'json', type?: import('./anki.js').CardType, name?: string }} [opts]
   */
  function exportAnki(questions, opts = {}) {
    const { format = 'tsv', type = 'basic', name = 'dams-anki' } = opts;
    const cards = buildCards(questions, type);
    let content, mime, ext;
    if (format === 'csv') { content = toCSV(cards); mime = 'text/csv'; ext = 'csv'; }
    else if (format === 'json') { content = toJSON(cards); mime = 'application/json'; ext = 'json'; }
    else { content = toTSV(cards); mime = 'text/tab-separated-values'; ext = 'txt'; }
    downloadFile(`${sanitize(name)}-${type}.${ext}`, content, mime);
  }

  /**
   * @param {import('./quiz.js').Quiz} quiz @param {string} [name]
   */
  function exportSession(quiz, name = 'dams-session') {
    const payload = {
      meta: { format: 'dams-universal-session', version: 1, generatedAt: new Date().toISOString(), deckId: quiz.deckId },
      questions: quiz.all,
      state: quiz.state,
    };
    downloadFile(`${sanitize(name)}.session.json`, safeStringify(payload, 2), 'application/json');
  }

  /**
   * @param {string} text @returns {{ questions: any[], state: any|null }}
   */
  function parseSession(text) {
    const data = JSON.parse(text);
    return { questions: Array.isArray(data) ? data : data.questions || [], state: data.state || null };
  }

  DAMS.exporter = { toUniversalJSON, exportUniversalJSON, exportAnki, exportSession, parseSession };
})(window.DAMS = window.DAMS || {});
