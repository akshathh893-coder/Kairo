'use strict';

/**
 * @file quiz.js
 * @description The quiz engine: owns the canonical question deck plus all
 * session state (current index, answers, bookmarks, marked-for-review, weak
 * areas, statistics, timer) and exposes navigation + filtering (all, bookmarks,
 * weak-only, incorrect-only, shuffle, random). State is persisted through
 * Storage and changes are broadcast via an Emitter.
 */

;(function (DAMS) {
  const { Emitter, clamp, shuffle, hash } = DAMS.utils;

  /**
   * @typedef {Object} Option
   * @property {string} text @property {string} html @property {boolean} isCorrect
   */
  /**
   * @typedef {Object} Question
   * @property {string} id @property {string} question @property {string} html
   * @property {Option[]} options @property {number} correctAnswer
   * @property {string} explanation @property {string} [explanationHtml]
   * @property {string[]} images @property {string[]} videos @property {string[]} audio
   * @property {string[]} tags @property {any} [raw]
   */

  const FILTERS = ['all', 'bookmarks', 'marked', 'weak', 'incorrect', 'unanswered'];

  class Quiz extends Emitter {
    /**
     * @param {Question[]} questions
     * @param {string} deckId
     * @param {{ storage?: { loadSession:Function, saveSession:Function } }} [deps]
     *   Optional dependency injection. `storage` is any object exposing
     *   loadSession/saveSession (a SessionStore). Defaults to the global
     *   `DAMS.storage.Storage` so `new Quiz(questions, deckId)` keeps working.
     */
    constructor(questions, deckId, deps = {}) {
      super();
      this.all = questions;
      this.deckId = deckId;
      /** @type {{ loadSession:Function, saveSession:Function }} */
      this.storage = deps.storage || DAMS.storage.Storage;
      this.state = this.storage.loadSession(deckId);
      /**
       * Incremental aggregate counters kept in sync as answers/flags change, so
       * answer() and stats() are O(1) instead of rescanning the answer map.
       * Derived once here (O(n)) from the loaded state, then maintained.
       * @type {{correct:number, wrong:number, weak:number, bookmarks:number, marked:number}}
       */
      this._counts = { correct: 0, wrong: 0, weak: 0, bookmarks: 0, marked: 0 };
      this._recount();
      this.filter = 'all';
      this.shuffled = false;
      this.timerStart = 0;
      this._timerHandle = null;
      this.order = questions.map((_, i) => i);
      this.pos = clamp(this.state.lastIndex || 0, 0, Math.max(0, this.order.length - 1));
      this._applyFilter();
      this.pos = clamp(this.state.lastIndex || 0, 0, Math.max(0, this.order.length - 1));
    }

    /** @returns {Question|null} */
    current() {
      const idx = this.order[this.pos];
      return idx == null ? null : this.all[idx];
    }

    displayNumber() { return this.pos + 1; }
    total() { return this.order.length; }

    save() {
      this.state.lastIndex = this.pos;
      this.state.stats.elapsed = this.elapsed();
      this.storage.saveSession(this.deckId, this.state);
    }

    // ---- Navigation --------------------------------------------------------
    next() {
      if (!this.order.length) return;
      this.pos = (this.pos + 1) % this.order.length;
      this._changed();
    }
    prev() {
      if (!this.order.length) return;
      this.pos = (this.pos - 1 + this.order.length) % this.order.length;
      this._changed();
    }
    jumpTo(n) {
      if (!this.order.length) return;
      this.pos = clamp(Math.round(n) - 1, 0, this.order.length - 1);
      this._changed();
    }
    random() {
      if (!this.order.length) return;
      this.pos = Math.floor(Math.random() * this.order.length);
      this._changed();
    }

    // ---- Answering ---------------------------------------------------------
    /**
     * @param {number} choiceIndex @returns {{correct:boolean, correctIndex:number}}
     */
    answer(choiceIndex) {
      const q = this.current();
      if (!q) return { correct: false, correctIndex: -1 };
      const correct = q.correctAnswer >= 0 && choiceIndex === q.correctAnswer;
      const prev = this.state.answers[q.id];

      // Roll back the previous answer's contribution (supports re-answering).
      if (prev) {
        if (prev.correct) this._counts.correct--;
        else this._counts.wrong--;
      } else {
        this.state.stats.seen++;
      }

      this.state.answers[q.id] = { correct, chosen: choiceIndex, at: Date.now() };

      if (correct) {
        this._counts.correct++;
        if (this.state.weak[q.id] != null) {
          delete this.state.weak[q.id];
          this._counts.weak--;
        }
      } else {
        this._counts.wrong++;
        if (this.state.weak[q.id] == null) this._counts.weak++;
        this.state.weak[q.id] = (this.state.weak[q.id] || 0) + 1;
      }

      this.state.stats.correct = this._counts.correct;
      this.state.stats.wrong = this._counts.wrong;
      this.save();
      this.emit('answered', { question: q, choiceIndex, correct });
      this.emit('stats', this.stats());
      return { correct, correctIndex: q.correctAnswer };
    }

    currentAnswer() {
      const q = this.current();
      return q ? this.state.answers[q.id] || null : null;
    }

    // ---- Bookmarks / review flags -----------------------------------------
    toggleBookmark() {
      const q = this.current();
      if (!q) return false;
      const val = !this.state.bookmarks[q.id];
      if (val) {
        this.state.bookmarks[q.id] = true;
        this._counts.bookmarks++;
      } else {
        delete this.state.bookmarks[q.id];
        this._counts.bookmarks--;
      }
      this.save();
      this.emit('bookmark', { id: q.id, value: val });
      return val;
    }
    toggleMarked() {
      const q = this.current();
      if (!q) return false;
      const val = !this.state.marked[q.id];
      if (val) {
        this.state.marked[q.id] = true;
        this._counts.marked++;
      } else {
        delete this.state.marked[q.id];
        this._counts.marked--;
      }
      this.save();
      this.emit('marked', { id: q.id, value: val });
      return val;
    }
    isBookmarked(q = this.current()) { return !!(q && this.state.bookmarks[q.id]); }
    isMarked(q = this.current()) { return !!(q && this.state.marked[q.id]); }

    // ---- Filters / modes ---------------------------------------------------
    setFilter(filter) {
      this.filter = filter;
      this._applyFilter();
      this.pos = 0;
      this._changed();
      this.emit('filter', { filter, total: this.order.length });
    }
    toggleShuffle() {
      this.shuffled = !this.shuffled;
      this._applyFilter();
      this.pos = 0;
      this._changed();
      return this.shuffled;
    }
    _applyFilter() {
      let indices = this.all.map((_, i) => i);
      const keepIf = (pred) => { indices = indices.filter((i) => pred(this.all[i])); };
      switch (this.filter) {
        case 'bookmarks': keepIf((q) => this.state.bookmarks[q.id]); break;
        case 'marked': keepIf((q) => this.state.marked[q.id]); break;
        case 'weak': keepIf((q) => this.state.weak[q.id] > 0); break;
        case 'incorrect': keepIf((q) => this.state.answers[q.id] && !this.state.answers[q.id].correct); break;
        case 'unanswered': keepIf((q) => !this.state.answers[q.id]); break;
        case 'all':
        default: break;
      }
      if (this.shuffled) indices = shuffle(indices);
      if (indices.length === 0 && this.filter !== 'all') {
        indices = this.all.map((_, i) => i);
        this.filter = 'all';
      }
      this.order = indices;
    }

    // ---- Timer -------------------------------------------------------------
    startTimer() {
      this.timerStart = Date.now() - (this.state.stats.elapsed || 0);
      if (this._timerHandle) clearInterval(this._timerHandle);
      this._timerHandle = setInterval(() => this.emit('tick', this.elapsed()), 1000);
    }
    stopTimer() {
      if (this._timerHandle) clearInterval(this._timerHandle);
      this._timerHandle = null;
      this.state.stats.elapsed = this.elapsed();
      this.save();
    }
    elapsed() {
      return this.timerStart ? Date.now() - this.timerStart : this.state.stats.elapsed || 0;
    }

    // ---- Statistics --------------------------------------------------------
    /**
     * O(1): every field is read from the incrementally-maintained counters.
     * @returns {{total:number, answered:number, correct:number, wrong:number,
     *   bookmarks:number, marked:number, weak:number, accuracy:number, elapsed:number}}
     */
    stats() {
      const { correct, wrong, weak, bookmarks, marked } = this._counts;
      const answered = correct + wrong;
      return {
        total: this.all.length,
        answered,
        correct,
        wrong,
        bookmarks,
        marked,
        weak,
        accuracy: answered ? Math.round((correct / answered) * 100) : 0,
        elapsed: this.elapsed(),
      };
    }

    /**
     * Rebuild the aggregate counters from `this.state` in one O(n) pass. Called
     * on construction and after any bulk state replacement (e.g. session import)
     * to keep the O(1) counters consistent with the underlying maps.
     */
    _recount() {
      let correct = 0;
      let wrong = 0;
      for (const a of Object.values(this.state.answers)) {
        if (a && a.correct) correct++;
        else wrong++;
      }
      this._counts = {
        correct,
        wrong,
        weak: Object.keys(this.state.weak).length,
        bookmarks: Object.keys(this.state.bookmarks).length,
        marked: Object.keys(this.state.marked).length,
      };
    }

    /**
     * Public: resynchronize counters after external code mutates `this.state`
     * directly (import flow). Idempotent and safe to call any time.
     */
    recountStats() {
      this._recount();
    }

    reset() {
      this.state = this.storage.loadSession(this.deckId);
      this.state.answers = {};
      this.state.weak = {};
      this.state.bookmarks = {};
      this.state.marked = {};
      this.state.stats = { seen: 0, correct: 0, wrong: 0, startedAt: Date.now(), elapsed: 0 };
      this._counts = { correct: 0, wrong: 0, weak: 0, bookmarks: 0, marked: 0 };
      this.timerStart = Date.now();
      this._applyFilter();
      this.pos = 0;
      this.save();
      this._changed();
      this.emit('stats', this.stats());
    }

    _changed() {
      this.save();
      this.emit('change', { question: this.current(), pos: this.pos, total: this.order.length, answer: this.currentAnswer() });
    }

    select(pred) { return this.all.filter(pred); }
    weakQuestions() { return this.select((q) => this.state.weak[q.id] > 0); }
    incorrectQuestions() { return this.select((q) => this.state.answers[q.id] && !this.state.answers[q.id].correct); }
    bookmarkedQuestions() { return this.select((q) => this.state.bookmarks[q.id]); }
  }

  /**
   * Stable deck id from content so sessions resume across reloads.
   * @param {Question[]} questions @param {string} fileName @returns {string}
   */
  function deckIdFor(questions, fileName) {
    const sample = questions.slice(0, 20).map((q) => q.question).join('|');
    return `${hash(fileName + '::' + questions.length + '::' + sample)}`;
  }

  DAMS.quiz = { Quiz, deckIdFor, FILTERS };
})(window.DAMS = window.DAMS || {});
