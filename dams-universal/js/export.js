'use strict';

/**
 * @file export.js
 * @description Export/import orchestration, split into two layers:
 *
 *   - Pure serializers that RETURN artifacts `{ filename, mime, content }` and
 *     have no side effects — these are what the embeddable Exporter facade and
 *     any headless host (Kairos AI) use.
 *   - Thin download wrappers (`export*`) that call a serializer and then hand
 *     the result to the DOM download helper — these are for the standalone UI.
 *
 * Separating them keeps business logic (serialization) independent of the UI
 * side effect (triggering a browser download), so serialization is testable and
 * reusable outside a browser DOM.
 */

;(function (DAMS) {
  const { downloadFile, safeStringify } = DAMS.utils;
  const { buildCards, toTSV, toCSV, toJSON } = DAMS.anki;

  function sanitize(s) {
    return String(s || 'export').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80);
  }

  // ---- Pure serializers (no side effects) ---------------------------------

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
   * Build a universal-JSON artifact.
   * @param {import('./quiz.js').Question[]} questions @param {string} [name] @param {Object} [meta]
   * @returns {{filename:string, mime:string, content:string}}
   */
  function universalArtifact(questions, name = 'dams-quiz', meta) {
    return { filename: `${sanitize(name)}.json`, mime: 'application/json', content: toUniversalJSON(questions, meta) };
  }

  /**
   * Build an Anki artifact.
   * @param {import('./quiz.js').Question[]} questions
   * @param {{ format?: 'tsv'|'csv'|'json', type?: import('./anki.js').CardType, name?: string }} [opts]
   * @returns {{filename:string, mime:string, content:string}}
   */
  function ankiArtifact(questions, opts = {}) {
    const { format = 'tsv', type = 'basic', name = 'dams-anki' } = opts;
    const cards = buildCards(questions, type);
    let content, mime, ext;
    if (format === 'csv') { content = toCSV(cards); mime = 'text/csv'; ext = 'csv'; }
    else if (format === 'json') { content = toJSON(cards); mime = 'application/json'; ext = 'json'; }
    else { content = toTSV(cards); mime = 'text/tab-separated-values'; ext = 'txt'; }
    return { filename: `${sanitize(name)}-${type}.${ext}`, mime, content };
  }

  /**
   * Build a full-session artifact (deck + progress).
   * @param {import('./quiz.js').Quiz} quiz @param {string} [name]
   * @returns {{filename:string, mime:string, content:string}}
   */
  function sessionArtifact(quiz, name = 'dams-session') {
    const payload = {
      meta: { format: 'dams-universal-session', version: 1, generatedAt: new Date().toISOString(), deckId: quiz.deckId },
      questions: quiz.all,
      state: quiz.state,
    };
    return { filename: `${sanitize(name)}.session.json`, mime: 'application/json', content: safeStringify(payload, 2) };
  }

  /**
   * @param {string} text @returns {{ questions: any[], state: any|null }}
   */
  function parseSession(text) {
    const data = JSON.parse(text);
    return { questions: Array.isArray(data) ? data : data.questions || [], state: data.state || null };
  }

  // ---- Download wrappers (UI side effects) --------------------------------

  /** @param {{filename:string, mime:string, content:string}} art */
  function download(art) {
    downloadFile(art.filename, art.content, art.mime);
  }

  function exportUniversalJSON(questions, name = 'dams-quiz', meta) {
    download(universalArtifact(questions, name, meta));
  }
  function exportAnki(questions, opts = {}) {
    download(ankiArtifact(questions, opts));
  }
  function exportSession(quiz, name = 'dams-session') {
    download(sessionArtifact(quiz, name));
  }

  DAMS.exporter = {
    // pure serializers
    toUniversalJSON,
    universalArtifact,
    ankiArtifact,
    sessionArtifact,
    parseSession,
    // download wrappers
    exportUniversalJSON,
    exportAnki,
    exportSession,
  };
})(window.DAMS = window.DAMS || {});
