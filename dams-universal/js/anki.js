'use strict';

/**
 * @file anki.js
 * @description Builds Anki-importable decks from canonical questions. Supports
 * Basic cards, Cloze cards, and Image cards, and can emit TSV (Anki's native
 * import format), CSV, or JSON. Subsets (weak-only / incorrect-only) are
 * produced by passing a filtered question list.
 */

;(function (DAMS) {
  const { stripHtml } = DAMS.utils;

  /** @typedef {'basic'|'cloze'|'image'} CardType */
  /** @typedef {Object} AnkiCard @property {string} front @property {string} back @property {string} tags @property {CardType} type */

  function escapeAttr(v) {
    return String(v ?? '').replace(/"/g, '&quot;');
  }

  /**
   * @param {import('./quiz.js').Question} q @returns {string}
   */
  function frontHtml(q) {
    const opts = q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o.html || o.text}`).join('<br>');
    const imgs = q.images.map((src) => `<br><img src="${escapeAttr(src)}">`).join('');
    return `${q.html || q.question}${opts ? '<br><br>' + opts : ''}${imgs}`;
  }

  /**
   * @param {import('./quiz.js').Question} q @returns {string}
   */
  function backHtml(q) {
    const correct =
      q.correctAnswer >= 0 && q.options[q.correctAnswer]
        ? `<b>${String.fromCharCode(65 + q.correctAnswer)}. ${q.options[q.correctAnswer].html || q.options[q.correctAnswer].text}</b>`
        : '<i>Answer not encoded in source</i>';
    const exp = q.explanationHtml || q.explanation ? `<br><br>${q.explanationHtml || q.explanation}` : '';
    return `${correct}${exp}`;
  }

  /**
   * Build cards for a set of questions.
   * @param {import('./quiz.js').Question[]} questions @param {CardType} [type='basic'] @returns {AnkiCard[]}
   */
  function buildCards(questions, type = 'basic') {
    return questions.map((q) => {
      const tags = (q.tags || []).map((t) => t.replace(/\s+/g, '_')).join(' ') || 'DAMS';
      if (type === 'cloze') {
        const answer = q.correctAnswer >= 0 && q.options[q.correctAnswer] ? q.options[q.correctAnswer].text : '';
        const front = answer ? `${q.question} {{c1::${answer}}}` : `${q.question} {{c1::?}}`;
        return { front, back: q.explanation || '', tags, type };
      }
      if (type === 'image') {
        const img = q.images[0] ? `<img src="${escapeAttr(q.images[0])}">` : '';
        return { front: `${q.html || q.question}<br>${img}`, back: backHtml(q), tags, type };
      }
      return { front: frontHtml(q), back: backHtml(q), tags, type };
    });
  }

  function tsvField(v) {
    return String(v ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, '<br>');
  }
  function csvField(v) {
    const s = String(v ?? '').replace(/\r?\n/g, ' ');
    return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  /**
   * @param {AnkiCard[]} cards @returns {string}
   */
  function toTSV(cards) {
    const header = ['#separator:tab', '#html:true', '#columns:Front\tBack\tTags', '#tags column:3'];
    const rows = cards.map((c) => [tsvField(c.front), tsvField(c.back), tsvField(c.tags)].join('\t'));
    return header.join('\n') + '\n' + rows.join('\n');
  }
  /**
   * @param {AnkiCard[]} cards @returns {string}
   */
  function toCSV(cards) {
    const header = ['Front', 'Back', 'Tags'].join(',');
    const rows = cards.map((c) => [csvField(c.front), csvField(c.back), csvField(c.tags)].join(','));
    return [header, ...rows].join('\n');
  }
  /**
   * @param {AnkiCard[]} cards @returns {string}
   */
  function toJSON(cards) {
    return JSON.stringify(cards, null, 2);
  }
  /**
   * @param {AnkiCard} card @returns {string}
   */
  function previewCard(card) {
    return `${stripHtml(card.front)}\n---\n${stripHtml(card.back)}`;
  }

  DAMS.anki = { buildCards, toTSV, toCSV, toJSON, previewCard };
})(window.DAMS = window.DAMS || {});
