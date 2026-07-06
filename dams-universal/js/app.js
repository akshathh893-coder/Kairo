'use strict';

/**
 * @file app.js
 * @description Application controller. Wires the DOM to the extraction pipeline
 * and the quiz engine: file loading, live extraction progress, question
 * rendering (with images / video / audio), navigation, search, filters, timer,
 * statistics, export/import, dark mode, and the hidden debug panel.
 */

;(function (DAMS) {
  const { $, $$, el, escapeHtml, debounce, formatTime, downloadFile } = DAMS.utils;
  const { loadFile, wireDropZone, readFileText } = DAMS.loader;
  const { extract } = DAMS.parser;
  const { Quiz, deckIdFor, FILTERS } = DAMS.quiz;
  const { SearchIndex } = DAMS.search;
  const { Storage } = DAMS.storage;
  const { exportUniversalJSON, exportAnki, exportSession, parseSession } = DAMS.exporter;
  const { normalizeImported } = DAMS.normalizer;

  /** @type {InstanceType<typeof Quiz>|null} */
  let quiz = null;
  /** @type {InstanceType<typeof SearchIndex>|null} */
  let index = null;
  let lastReport = null;

  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    wireGlobalControls();
    wireLoader();
    wireQuizControls();
    wireSearch();
    wireExport();
    wireDebug();
  });

  // ---- Theme ---------------------------------------------------------------
  function initTheme() {
    const saved = Storage.get('theme', null);
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const dark = saved == null ? prefersDark : saved === 'dark';
    document.documentElement.classList.toggle('dark', dark);
  }

  function wireGlobalControls() {
    $('#themeToggle')?.addEventListener('click', () => {
      const dark = document.documentElement.classList.toggle('dark');
      Storage.set('theme', dark ? 'dark' : 'light');
    });
    $('#debugToggle')?.addEventListener('click', () => {
      const panel = $('#debugPanel');
      if (panel) panel.hidden = !panel.hidden;
      if (panel && !panel.hidden) renderDebug();
    });
    $('#homeBtn')?.addEventListener('click', () => showView('landing'));
  }

  /**
   * @param {'landing'|'loading'|'quiz'} name
   */
  function showView(name) {
    ['landing', 'loading', 'quiz'].forEach((v) => {
      const node = $(`#view-${v}`);
      if (node) node.hidden = v !== name;
    });
    const toolbar = $('#appToolbar');
    if (toolbar) toolbar.hidden = name !== 'quiz';
  }

  // ---- Loader + extraction -------------------------------------------------
  function wireLoader() {
    const zone = $('#dropZone');
    const input = /** @type {HTMLInputElement} */ ($('#fileInput'));
    if (zone && input) wireDropZone(zone, input, handleFile);
    $('#sampleBtn')?.addEventListener('click', () => loadSample());
  }

  /**
   * @param {File} file
   */
  async function handleFile(file) {
    showView('loading');
    setProgress(0, 'Reading file...');
    clearLog();
    try {
      const loaded = await loadFile(file);
      const report = await extract(loaded, (msg, pct) => {
        appendLog(msg);
        if (typeof pct === 'number') setProgress(pct, msg);
      });
      lastReport = report;
      if (!report.questions.length) {
        setProgress(100, 'No questions found — open the debug panel for details.');
        appendLog('⚠ Extraction finished with 0 questions.');
        $('#loadingActions').hidden = false;
        return;
      }
      startQuiz(report.questions, file.name, report);
    } catch (err) {
      appendLog('✖ Fatal: ' + (err && err.message ? err.message : String(err)));
      setProgress(100, 'Extraction failed.');
      $('#loadingActions').hidden = false;
    }
  }

  /**
   * @param {any[]} questions @param {string} fileName @param {any} [report]
   */
  function startQuiz(questions, fileName, report) {
    const deckId = deckIdFor(questions, fileName);
    quiz = new Quiz(questions, deckId);
    index = new SearchIndex(questions);
    quiz.startTimer();

    quiz.on('change', renderQuestion);
    quiz.on('stats', renderStats);
    quiz.on('tick', () => {
      const t = $('#statTime');
      if (t) t.textContent = formatTime(quiz.elapsed());
    });

    $('#deckName').textContent = fileName;
    $('#deckMeta').textContent = `${questions.length} questions · strategy: ${report?.strategy || 'n/a'}`;
    showView('quiz');
    renderFilters();
    renderStats(quiz.stats());
    renderQuestion({ question: quiz.current(), pos: quiz.pos, total: quiz.total(), answer: quiz.currentAnswer() });
  }

  function setProgress(pct, label) {
    const bar = $('#progressBar');
    if (bar) bar.style.width = `${Math.round(pct)}%`;
    const lbl = $('#progressLabel');
    if (lbl && label) lbl.textContent = label;
  }
  function clearLog() {
    const log = $('#extractLog');
    if (log) log.textContent = '';
    $('#loadingActions').hidden = true;
  }
  function appendLog(msg) {
    const log = $('#extractLog');
    if (!log) return;
    log.textContent += (log.textContent ? '\n' : '') + msg;
    log.scrollTop = log.scrollHeight;
  }

  async function loadSample() {
    const sample = [
      {
        question: 'The most common cause of lobar pneumonia is?',
        options: ['Streptococcus pneumoniae', 'Klebsiella', 'Staph aureus', 'Mycoplasma'],
        correct: 0,
        explanation: 'S. pneumoniae is the classic cause of lobar pneumonia.',
        tags: ['Microbiology', 'Respiratory'],
      },
      {
        stem: 'Which vitamin deficiency causes scurvy?',
        choices: ['Vitamin A', 'Vitamin C', 'Vitamin D', 'Vitamin K'],
        answer: 'B',
        solution: 'Scurvy is caused by Vitamin C (ascorbic acid) deficiency.',
        subject: 'Biochemistry',
      },
      {
        text: 'The powerhouse of the cell is the ____?',
        opts: [
          { text: 'Nucleus', correct: false },
          { text: 'Mitochondria', correct: true },
          { text: 'Ribosome', correct: false },
        ],
        rationale: 'Mitochondria generate ATP via oxidative phosphorylation.',
        topic: 'Cell Biology',
      },
    ];
    showView('loading');
    clearLog();
    appendLog('Loading built-in sample deck...');
    setProgress(100, 'Sample ready.');
    lastReport = { strategy: 'sample', questions: [], debug: {}, log: [], candidates: [] };
    const { questions } = normalizeImported({ questions: sample });
    startQuiz(questions, 'sample-deck', { strategy: 'sample' });
  }

  // ---- Question rendering --------------------------------------------------
  function renderQuestion(view) {
    const host = $('#questionCard');
    if (!host) return;
    const q = view.question;
    if (!q) {
      host.innerHTML = '<p class="muted">No question in this filter.</p>';
      return;
    }
    const answered = quiz?.currentAnswer();

    host.innerHTML = '';
    host.appendChild(
      el('div', { class: 'q-head' }, [
        el('span', { class: 'q-index' }, `Q ${view.pos + 1} / ${view.total}`),
        el('div', { class: 'q-flags' }, [
          el('button', {
            class: 'chip' + (quiz.isBookmarked() ? ' active' : ''),
            title: 'Bookmark (B)',
            onClick: () => { quiz.toggleBookmark(); renderQuestion(currentView()); },
          }, '★ Bookmark'),
          el('button', {
            class: 'chip' + (quiz.isMarked() ? ' active' : ''),
            title: 'Mark for review (M)',
            onClick: () => { quiz.toggleMarked(); renderQuestion(currentView()); },
          }, '⚑ Review'),
        ]),
      ]),
    );

    if (q.tags.length) host.appendChild(el('div', { class: 'q-tags' }, q.tags.map((t) => el('span', { class: 'tag' }, t))));

    host.appendChild(el('div', { class: 'q-text', html: q.html || escapeHtml(q.question) }));
    renderMedia(host, q);

    const opts = el('div', { class: 'q-options' });
    q.options.forEach((opt, i) => {
      const chosen = answered && answered.chosen === i;
      const isCorrect = q.correctAnswer === i;
      let cls = 'option';
      if (answered) {
        if (isCorrect) cls += ' correct';
        else if (chosen) cls += ' wrong';
      }
      opts.appendChild(
        el('button', {
          class: cls,
          disabled: !!answered,
          onClick: () => {
            if (quiz.currentAnswer()) return;
            quiz.answer(i);
            renderQuestion(currentView());
          },
        }, [
          el('span', { class: 'opt-letter' }, String.fromCharCode(65 + i)),
          el('span', { class: 'opt-body', html: opt.html || escapeHtml(opt.text) }),
        ]),
      );
    });
    host.appendChild(opts);

    if (answered && (q.explanation || q.explanationHtml)) {
      host.appendChild(
        el('div', { class: 'q-explanation' }, [
          el('div', { class: 'exp-label' }, answered.correct ? '✓ Correct' : '✗ Incorrect — Explanation'),
          el('div', { class: 'exp-body', html: q.explanationHtml || escapeHtml(q.explanation) }),
        ]),
      );
    } else if (answered && q.correctAnswer < 0) {
      host.appendChild(el('div', { class: 'q-explanation muted' }, 'This question has no answer key encoded in the source file.'));
    }

    const jump = /** @type {HTMLInputElement} */ ($('#jumpInput'));
    if (jump) { jump.max = String(view.total); jump.value = String(view.pos + 1); }
    const prog = $('#quizProgressBar');
    if (prog) prog.style.width = `${((view.pos + 1) / Math.max(1, view.total)) * 100}%`;
  }

  /**
   * @param {HTMLElement} host @param {any} q
   */
  function renderMedia(host, q) {
    if (!q.images.length && !q.videos.length && !q.audio.length) return;
    const media = el('div', { class: 'q-media' });
    q.images.forEach((src) => media.appendChild(el('img', { src, loading: 'lazy', alt: 'question image', class: 'q-img' })));
    q.videos.forEach((src) => {
      if (/\.m3u8|hls/i.test(src)) media.appendChild(el('video', { controls: true, class: 'q-video', src }));
      else if (/youtube|vimeo|<iframe|embed/i.test(src)) media.appendChild(el('iframe', { src: extractIframeSrc(src), class: 'q-embed', allowfullscreen: true }));
      else media.appendChild(el('video', { controls: true, class: 'q-video', src }));
    });
    q.audio.forEach((src) => media.appendChild(el('audio', { controls: true, class: 'q-audio', src })));
    host.appendChild(media);
  }

  function extractIframeSrc(s) {
    const m = /src\s*=\s*["']([^"']+)["']/i.exec(s);
    return m ? m[1] : s;
  }

  function currentView() {
    return { question: quiz.current(), pos: quiz.pos, total: quiz.total(), answer: quiz.currentAnswer() };
  }

  // ---- Stats + filters -----------------------------------------------------
  function renderStats(s) {
    const set = (id, v) => {
      const n = $('#' + id);
      if (n) n.textContent = String(v);
    };
    set('statTotal', s.total);
    set('statAnswered', s.answered);
    set('statCorrect', s.correct);
    set('statWrong', s.wrong);
    set('statAccuracy', s.accuracy + '%');
    set('statWeak', s.weak);
    set('statBookmarks', s.bookmarks);
    const time = $('#statTime');
    if (time) time.textContent = formatTime(s.elapsed);
  }

  function renderFilters() {
    const host = $('#filterBar');
    if (!host || !quiz) return;
    const labels = { all: 'All', bookmarks: '★ Bookmarks', marked: '⚑ Review', weak: 'Weak', incorrect: 'Incorrect', unanswered: 'Unanswered' };
    host.innerHTML = '';
    FILTERS.forEach((f) => {
      host.appendChild(
        el('button', {
          class: 'filter' + (quiz.filter === f ? ' active' : ''),
          onClick: () => { quiz.setFilter(f); renderFilters(); },
        }, labels[f]),
      );
    });
    host.appendChild(
      el('button', {
        class: 'filter' + (quiz.shuffled ? ' active' : ''),
        onClick: () => { quiz.toggleShuffle(); renderFilters(); },
      }, '⇄ Shuffle'),
    );
  }

  // ---- Quiz navigation controls -------------------------------------------
  function wireQuizControls() {
    $('#prevBtn')?.addEventListener('click', () => quiz?.prev());
    $('#nextBtn')?.addEventListener('click', () => quiz?.next());
    $('#randomBtn')?.addEventListener('click', () => quiz?.random());
    $('#resetBtn')?.addEventListener('click', () => {
      if (quiz && confirm('Reset all progress for this deck?')) quiz.reset();
    });
    const jump = /** @type {HTMLInputElement} */ ($('#jumpInput'));
    jump?.addEventListener('change', () => quiz?.jumpTo(Number(jump.value)));

    document.addEventListener('keydown', (e) => {
      if (!quiz || $('#view-quiz')?.hidden) return;
      const tag = /** @type {HTMLElement} */ (e.target)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowRight') quiz.next();
      else if (e.key === 'ArrowLeft') quiz.prev();
      else if (e.key.toLowerCase() === 'b') { quiz.toggleBookmark(); renderQuestion(currentView()); }
      else if (e.key.toLowerCase() === 'm') { quiz.toggleMarked(); renderQuestion(currentView()); }
      else if (/^[1-9]$/.test(e.key)) {
        const q = quiz.current();
        if (q && !quiz.currentAnswer() && Number(e.key) <= q.options.length) {
          quiz.answer(Number(e.key) - 1);
          renderQuestion(currentView());
        }
      }
    });
  }

  // ---- Search --------------------------------------------------------------
  function wireSearch() {
    const input = /** @type {HTMLInputElement} */ ($('#searchInput'));
    const results = $('#searchResults');
    if (!input || !results) return;
    const run = debounce(() => {
      if (!index) return;
      const hits = index.search(input.value, 60);
      results.innerHTML = '';
      if (!input.value.trim()) {
        results.appendChild(el('p', { class: 'muted' }, 'Type to search questions, answers, tags and explanations.'));
        return;
      }
      if (!hits.length) {
        results.appendChild(el('p', { class: 'muted' }, 'No matches.'));
        return;
      }
      hits.forEach((h) => {
        results.appendChild(
          el('button', {
            class: 'search-hit',
            onClick: () => {
              if (quiz.filter !== 'all') { quiz.setFilter('all'); renderFilters(); }
              const orderPos = quiz.order.indexOf(h.idx);
              if (orderPos >= 0) quiz.jumpTo(orderPos + 1);
              closeSearch();
            },
          }, [
            el('div', { class: 'hit-q' }, h.question.question.slice(0, 140)),
            el('div', { class: 'hit-meta' }, (h.question.tags || []).join(' · ')),
          ]),
        );
      });
    }, 120);
    input.addEventListener('input', run);
    $('#searchBtn')?.addEventListener('click', openSearch);
    $('#searchClose')?.addEventListener('click', closeSearch);
    $('#searchOverlay')?.addEventListener('click', (e) => { if (e.target === $('#searchOverlay')) closeSearch(); });
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
      else if (e.key === 'Escape') closeSearch();
    });
  }
  function openSearch() {
    const o = $('#searchOverlay');
    if (o) o.hidden = false;
    /** @type {HTMLInputElement} */ ($('#searchInput'))?.focus();
  }
  function closeSearch() {
    const o = $('#searchOverlay');
    if (o) o.hidden = true;
  }

  // ---- Export / import -----------------------------------------------------
  function wireExport() {
    $('#exportBtn')?.addEventListener('click', () => {
      const p = $('#exportPanel');
      if (p) p.hidden = !p.hidden;
    });
    $('#expJson')?.addEventListener('click', () => quiz && exportUniversalJSON(quiz.all, deckFileName(), { source: $('#deckName')?.textContent }));
    $('#expSession')?.addEventListener('click', () => quiz && exportSession(quiz, deckFileName()));

    const ankiExport = (type, format, subset) => {
      if (!quiz) return;
      let list = quiz.all;
      if (subset === 'weak') list = quiz.weakQuestions();
      else if (subset === 'incorrect') list = quiz.incorrectQuestions();
      else if (subset === 'bookmarks') list = quiz.bookmarkedQuestions();
      if (!list.length) { alert('No questions match this subset yet.'); return; }
      exportAnki(list, { type, format, name: deckFileName() + '-' + subset });
    };

    $$('[data-anki]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const type = btn.getAttribute('data-type') || 'basic';
        const format = btn.getAttribute('data-format') || 'tsv';
        const subset = $('#ankiSubset') ? /** @type {HTMLSelectElement} */ ($('#ankiSubset')).value : 'all';
        ankiExport(type, format, subset);
      });
    });

    const importInput = /** @type {HTMLInputElement} */ ($('#importInput'));
    $('#importBtn')?.addEventListener('click', () => importInput?.click());
    importInput?.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      try {
        const text = await readFileText(file);
        const { questions, state } = parseSession(text);
        const norm = normalizeImported({ questions });
        if (!norm.questions.length) { alert('No questions found in that file.'); return; }
        startQuiz(norm.questions, file.name, { strategy: 'import' });
        if (state && quiz) {
          Object.assign(quiz.state, state);
          quiz.save();
          renderStats(quiz.stats());
          renderQuestion(currentView());
        }
      } catch (err) {
        alert('Import failed: ' + (err && err.message));
      }
      importInput.value = '';
    });
  }

  function deckFileName() {
    return ($('#deckName')?.textContent || 'dams-quiz').replace(/\.[a-z]+$/i, '');
  }

  // ---- Debug panel ---------------------------------------------------------
  function wireDebug() {
    $('#debugClose')?.addEventListener('click', () => {
      const p = $('#debugPanel');
      if (p) p.hidden = true;
    });
    $('#debugCopy')?.addEventListener('click', () => {
      if (lastReport) {
        const text = JSON.stringify(lastReport.debug, null, 2);
        navigator.clipboard?.writeText(text).then(
          () => alert('Debug info copied to clipboard.'),
          () => downloadFile('dams-debug.json', text, 'application/json'),
        );
      }
    });
  }

  function renderDebug() {
    const host = $('#debugContent');
    if (!host) return;
    if (!lastReport) {
      host.innerHTML = '<p class="muted">Load a DAMS file to populate diagnostics.</p>';
      return;
    }
    const d = lastReport.debug || {};
    const section = (title, body) => el('section', { class: 'dbg-section' }, [el('h4', {}, title), body]);
    host.innerHTML = '';

    host.appendChild(section('File', el('pre', {}, `${d.fileName || '—'}  (${d.fileSize || 0} bytes)\nscripts: ${d.scriptCount || 0}\nwinning strategy: ${lastReport.strategy}\nquestions: ${lastReport.questions.length}`)));
    host.appendChild(section('Runtime capture counts', el('pre', {}, JSON.stringify(d.captureCounts || {}, null, 2))));
    host.appendChild(section('Candidate banks (ranked)', el('pre', {}, (d.candidates || []).map((c, i) => `#${i + 1}  score=${c.score}  count=${c.count}  ← ${c.source}`).join('\n') || '(none)')));
    host.appendChild(section('Largest arrays discovered', el('pre', {}, (d.largestArrays || []).map((a) => `len=${a.length}\tbank=${a.isBank}\t${a.path}`).join('\n') || '(none)')));
    host.appendChild(section('Discovered globals', el('pre', {}, (d.globals || []).slice(0, 200).join(', ') || '(none)')));
    host.appendChild(section('Execution log', el('pre', {}, (lastReport.log || []).join('\n'))));
    host.appendChild(section('Sandbox errors', el('pre', {}, (d.errors || []).join('\n') || '(none)')));
  }
})(window.DAMS = window.DAMS || {});
