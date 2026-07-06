'use strict';

/**
 * @file test/harness.js
 * @description Dependency-free test runner + the full unit/protocol/integration
 * suite. Every subsystem is exercised in isolation using injected dependencies
 * (notably MemoryStorageAdapter), proving each module is independently testable
 * without the standalone UI. Results are rendered to the DOM and also exposed on
 * `window.__TEST_RESULTS__` so a headless driver can read them.
 */

;(function (DAMS) {
  /** @type {{name:string, pass:boolean, error?:string}[]} */
  const results = [];
  let current = 'root';

  function group(name) {
    current = name;
  }
  function test(name, fn) {
    try {
      fn();
      results.push({ name: `${current} › ${name}`, pass: true });
    } catch (err) {
      results.push({ name: `${current} › ${name}`, pass: false, error: (err && err.message) || String(err) });
    }
  }
  async function testAsync(name, fn) {
    try {
      await fn();
      results.push({ name: `${current} › ${name}`, pass: true });
    } catch (err) {
      results.push({ name: `${current} › ${name}`, pass: false, error: (err && err.message) || String(err) });
    }
  }
  function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
  }
  function eq(a, b, msg) {
    if (a !== b) throw new Error(`${msg || 'expected equality'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }

  // ========================================================================
  //  SUITE
  // ========================================================================
  async function runAll() {
    const I = DAMS.interfaces;
    const { MemoryStorageAdapter, LocalStorageAdapter, SessionStore } = DAMS.adapters;

    // ---- Protocols --------------------------------------------------------
    group('protocol');
    test('MemoryStorageAdapter satisfies StorageAdapter', () => {
      assert(I.StorageAdapter.isImplementedBy(new MemoryStorageAdapter()));
    });
    test('LocalStorageAdapter satisfies StorageAdapter', () => {
      assert(I.StorageAdapter.isImplementedBy(new LocalStorageAdapter()));
    });
    test('assert() throws with missing methods listed', () => {
      let msg = '';
      try {
        I.StorageAdapter.assert({ get() {} });
      } catch (e) {
        msg = e.message;
      }
      assert(msg.includes('set') && msg.includes('remove'), 'error should list missing methods, got: ' + msg);
    });

    // ---- Storage adapter --------------------------------------------------
    group('storage-adapter');
    test('MemoryStorageAdapter get/set/remove/clear/keys', () => {
      const s = new MemoryStorageAdapter();
      eq(s.get('x', 'def'), 'def', 'fallback');
      s.set('x', { a: 1 });
      eq(s.get('x').a, 1, 'round-trip');
      s.set('y', 2);
      assert(s.keys().includes('x') && s.keys().includes('y'), 'keys');
      s.remove('x');
      eq(s.get('x', null), null, 'removed');
      s.clear();
      eq(s.keys().length, 0, 'cleared');
    });
    test('MemoryStorageAdapter stores by value, not reference', () => {
      const s = new MemoryStorageAdapter();
      const obj = { n: 1 };
      s.set('k', obj);
      obj.n = 999;
      eq(s.get('k').n, 1, 'stored snapshot must be independent');
    });
    test('SessionStore loadSession returns stable default shape', () => {
      const store = new SessionStore(new MemoryStorageAdapter());
      const st = store.loadSession('deck1');
      assert(st.bookmarks && st.answers && st.weak && st.stats, 'shape');
      eq(st.lastIndex, 0, 'default index');
    });

    // ---- Normalizer -------------------------------------------------------
    group('normalizer');
    const { normalizeBank, normalizeQuestion } = DAMS.normalizer;
    test('numeric index correct answer', () => {
      const q = normalizeQuestion({ question: 'Q', options: ['a', 'b', 'c'], correct: 1 }, 0);
      eq(q.correctAnswer, 1);
    });
    test('letter answer resolves (B -> 1)', () => {
      const q = normalizeQuestion({ stem: 'Q', choices: ['a', 'b', 'c'], answer: 'B' }, 0);
      eq(q.correctAnswer, 1);
    });
    test('answer-by-text resolves', () => {
      const q = normalizeQuestion({ text: 'Q', options: ['Apple', 'Banana'], correct_answer: 'Banana' }, 0);
      eq(q.correctAnswer, 1);
    });
    test('boolean flag on option resolves', () => {
      const q = normalizeQuestion({ question: 'Q', opts: [{ text: 'x', correct: false }, { text: 'y', correct: true }] }, 0);
      eq(q.correctAnswer, 1);
    });
    test('missing key yields -1', () => {
      const q = normalizeQuestion({ question: 'Q', options: ['a', 'b'] }, 0);
      eq(q.correctAnswer, -1);
    });
    test('normalizeBank de-duplicates identical questions', () => {
      const dup = { question: 'Same', options: ['a', 'b'], correct: 0 };
      const { questions } = normalizeBank([dup, { ...dup }, { question: 'Other', options: ['c', 'd'], correct: 1 }]);
      eq(questions.length, 2);
    });
    test('empty question dropped', () => {
      const { questions } = normalizeBank([{ foo: 'bar' }]);
      eq(questions.length, 0);
    });

    // ---- Quiz engine (injected MemoryStorageAdapter) ----------------------
    group('quiz-engine');
    const sampleRaw = [
      { question: 'Q1', options: ['a', 'b', 'c'], correct: 0, tags: ['t1'] },
      { question: 'Q2', options: ['a', 'b'], correct: 1, tags: ['t2'] },
      { question: 'Q3', options: ['x', 'y'], correct: 0 },
    ];
    const makeQuiz = () => {
      const store = new SessionStore(new MemoryStorageAdapter());
      const { questions } = normalizeBank(sampleRaw);
      return new DAMS.quiz.Quiz(questions, 'test-deck', { storage: store });
    };
    test('answering correctly updates stats', () => {
      const q = makeQuiz();
      const r = q.answer(0); // Q1 correct is 0
      assert(r.correct, 'should be correct');
      eq(q.stats().correct, 1);
      eq(q.stats().answered, 1);
    });
    test('wrong answer records weak area', () => {
      const q = makeQuiz();
      q.answer(1); // Q1 correct is 0, so wrong
      eq(q.stats().wrong, 1);
      eq(q.weakQuestions().length, 1);
    });
    test('navigation wraps', () => {
      const q = makeQuiz();
      q.prev(); // from 0 wraps to last
      eq(q.displayNumber(), 3);
      q.next(); // wraps back to 1
      eq(q.displayNumber(), 1);
    });
    test('incorrect filter narrows deck', () => {
      const q = makeQuiz();
      q.answer(1); // wrong on Q1
      q.setFilter('incorrect');
      eq(q.total(), 1);
    });
    test('bookmark toggle + filter', () => {
      const q = makeQuiz();
      q.toggleBookmark();
      eq(q.stats().bookmarks, 1);
      q.setFilter('bookmarks');
      eq(q.total(), 1);
    });
    test('reset clears progress', () => {
      const q = makeQuiz();
      q.answer(1);
      q.toggleBookmark();
      q.reset();
      eq(q.stats().answered, 0);
      eq(q.stats().bookmarks, 0);
    });
    test('state persists through injected store across instances', () => {
      const store = new SessionStore(new MemoryStorageAdapter());
      const { questions } = normalizeBank(sampleRaw);
      const q1 = new DAMS.quiz.Quiz(questions, 'persist', { storage: store });
      q1.answer(0);
      const q2 = new DAMS.quiz.Quiz(questions, 'persist', { storage: store });
      eq(q2.stats().answered, 1, 'second instance sees persisted answer');
    });
    test('incremental counters match brute-force recount (incl. re-answer)', () => {
      const q = makeQuiz(); // Q1 correct=0, Q2 correct=1, Q3 correct=0
      q.answer(1); // Q1 wrong
      q.next();
      q.answer(1); // Q2 correct
      q.next();
      q.answer(1); // Q3 wrong
      // Re-answer Q1 correctly: navigate back to pos 0.
      q.jumpTo(1);
      q.answer(0); // Q1 now correct — must move it out of weak, correct++/wrong--
      const s = q.stats();
      // Brute-force truth from the raw answer map.
      const answers = Object.values(q.state.answers);
      const correct = answers.filter((a) => a.correct).length;
      const wrong = answers.length - correct;
      eq(s.correct, correct, 'correct counter');
      eq(s.wrong, wrong, 'wrong counter');
      eq(s.answered, answers.length, 'answered = correct + wrong');
      eq(s.weak, Object.keys(q.state.weak).length, 'weak counter');
      eq(s.correct, 2, 'Q2 + re-answered Q1');
      eq(s.weak, 1, 'only Q3 remains weak');
    });
    test('recountStats resyncs after direct state mutation (import path)', () => {
      const q = makeQuiz();
      // Simulate importing a session by replacing the state maps directly.
      q.state.answers = { a: { correct: true, chosen: 0, at: 1 }, b: { correct: false, chosen: 0, at: 1 } };
      q.state.weak = { b: 1 };
      q.state.bookmarks = { a: true };
      q.recountStats();
      const s = q.stats();
      eq(s.correct, 1);
      eq(s.wrong, 1);
      eq(s.weak, 1);
      eq(s.bookmarks, 1);
    });

    // ---- Search engine ----------------------------------------------------
    group('search-engine');
    test('finds by question text', () => {
      const { questions } = normalizeBank([
        { question: 'The mitochondria is the powerhouse', options: ['a', 'b'], correct: 0 },
        { question: 'Nucleus stores DNA', options: ['a', 'b'], correct: 0 },
      ]);
      const idx = new DAMS.search.SearchIndex(questions);
      eq(idx.search('mitochondria').length, 1);
      eq(idx.search('dna').length, 1);
      eq(idx.search('zzz').length, 0);
    });
    test('AND semantics across terms', () => {
      const { questions } = normalizeBank([
        { question: 'alpha beta gamma', options: ['a', 'b'], correct: 0 },
        { question: 'alpha only', options: ['a', 'b'], correct: 0 },
      ]);
      const idx = new DAMS.search.SearchIndex(questions);
      eq(idx.search('alpha beta').length, 1, 'both terms required');
    });

    // ---- Flashcard engine -------------------------------------------------
    group('flashcard-engine');
    test('build basic/cloze/image + serializers', () => {
      const { questions } = normalizeBank(sampleRaw);
      const basic = DAMS.anki.buildCards(questions, 'basic');
      eq(basic.length, 3);
      assert(basic[0].front && basic[0].back, 'basic has front/back');
      const cloze = DAMS.anki.buildCards(questions, 'cloze');
      assert(cloze[0].front.includes('{{c1::'), 'cloze marker');
      const tsv = DAMS.anki.toTSV(basic);
      assert(tsv.startsWith('#separator:tab'), 'tsv header');
      assert(DAMS.anki.toCSV(basic).startsWith('Front,Back,Tags'), 'csv header');
      assert(Array.isArray(JSON.parse(DAMS.anki.toJSON(basic))), 'json parses');
    });

    // ---- Exporter ---------------------------------------------------------
    group('exporter');
    test('universalJSON round-trips', () => {
      const { questions } = normalizeBank(sampleRaw);
      const json = DAMS.exporter.toUniversalJSON(questions);
      const back = JSON.parse(json);
      eq(back.questions.length, 3);
      eq(back.meta.format, 'dams-universal');
    });
    test('anki/session artifacts have filename+mime+content', () => {
      const { questions } = normalizeBank(sampleRaw);
      const a = DAMS.exporter.ankiArtifact(questions, { format: 'csv', type: 'basic' });
      assert(a.filename.endsWith('.csv') && a.mime === 'text/csv' && a.content, 'anki artifact');
    });
    test('parseSession recovers questions + state', () => {
      const payload = JSON.stringify({ questions: [{ question: 'q', options: [], correctAnswer: -1 }], state: { x: 1 } });
      const r = DAMS.exporter.parseSession(payload);
      eq(r.questions.length, 1);
      eq(r.state.x, 1);
    });

    // ---- Engine composition root + facades --------------------------------
    group('engine');
    test('createEngine with injected MemoryStorageAdapter', () => {
      const engine = DAMS.createEngine({ storage: new MemoryStorageAdapter() });
      assert(I.Extractor.isImplementedBy(engine.extractor), 'extractor facade');
      assert(I.FlashcardEngine.isImplementedBy(engine.flashcards), 'flashcard facade');
      assert(I.Exporter.isImplementedBy(engine.exporter), 'exporter facade');
      const q = engine.createQuiz(normalizeBank(sampleRaw).questions, 'e-deck');
      assert(I.QuizEngine.isImplementedBy(q), 'quiz facade');
      const s = engine.createSearch(normalizeBank(sampleRaw).questions);
      assert(I.SearchEngine.isImplementedBy(s), 'search facade');
    });
    test('rejects storage that violates protocol', () => {
      let threw = false;
      try {
        DAMS.createEngine({ storage: { get() {} } });
      } catch {
        threw = true;
      }
      assert(threw, 'should reject incomplete adapter');
    });

    // ---- Extraction integration (real DOM, headless storage) --------------
    group('extraction-integration');
    await testAsync('extractFromHtml discovers a push-built bank', async () => {
      const engine = DAMS.createEngine({ storage: new MemoryStorageAdapter() });
      const report = await engine.extractor.extractFromHtml(
        '<!doctype html><html><body><script>var BANK=[];[["Capital of France?",["Paris","Rome"],"A"],["2+2?",["3","4"],"B"]].forEach(function(r){BANK.push({question:r[0],options:r[1],answer:r[2]});});window.__b=BANK;<\/script></body></html>',
        'inline.html',
      );
      assert(report.questions.length === 2, 'expected 2 questions, got ' + report.questions.length);
      eq(report.questions[0].correctAnswer, 0, 'answer A -> 0');
    });
    await testAsync('extractFromHtml finds a const/closure bank via AST', async () => {
      const engine = DAMS.createEngine({ storage: new MemoryStorageAdapter() });
      const report = await engine.extractor.extractFromHtml(
        '<!doctype html><html><body><script>(function(){const HIDDEN=[{stem:"Q one?",choices:["a","b"],correct:0,explanation:"e"},{stem:"Q two?",choices:["c","d"],correct:1}];window.render=function(){return HIDDEN.length;};})();<\/script></body></html>',
        'closure.html',
      );
      assert(report.questions.length === 2, 'expected 2 from closure, got ' + report.questions.length);
    });

    render();
  }

  function render() {
    const passed = results.filter((r) => r.pass).length;
    const failed = results.length - passed;
    window.__TEST_RESULTS__ = { total: results.length, passed, failed, results };

    const root = document.getElementById('out') || document.body;
    const lines = results
      .map((r) => `${r.pass ? '✅' : '❌'} ${r.name}${r.error ? '  —  ' + r.error : ''}`)
      .join('\n');
    const summary = `${passed}/${results.length} passed${failed ? ` · ${failed} FAILED` : ''}`;
    root.innerHTML =
      `<h2 class="${failed ? 'fail' : 'ok'}">${summary}</h2><pre>${lines.replace(/</g, '&lt;')}</pre>`;
    document.title = `${failed ? 'FAIL' : 'PASS'} · DAMS tests`;
  }

  DAMS.__runTests = runAll;
  if (/\bauto=1\b/.test(location.search) || document.getElementById('out')) {
    document.addEventListener('DOMContentLoaded', runAll);
  }
})(window.DAMS = window.DAMS || {});
