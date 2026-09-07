'use strict';

/**
 * @file normalizer.js
 * @description Converts heterogeneous DAMS question objects (any version) into
 * the single canonical shape the rest of the app consumes:
 *
 *   { id, question, html, options, correctAnswer,
 *     explanation, images, videos, audio, tags }
 *
 * The normalizer is deliberately tolerant: it probes a wide set of candidate
 * field names, coerces option formats (arrays of strings, arrays of objects,
 * keyed maps) into a uniform array, and resolves the correct answer whether it
 * is stored as an index, a letter, the answer text, or a boolean flag on options.
 */

;(function (DAMS) {
  const { uid, hash, stripHtml } = DAMS.utils;

  const FIELDS = {
    question: ['question', 'question_text', 'questionText', 'stem', 'text', 'raw_text', 'rawtext', 'title', 'body', 'q', 'ques'],
    options: ['options', 'choices', 'opts', 'answers', 'option', 'choice', 'answerOptions'],
    correct: ['correctAnswer', 'correct_answer', 'correctanswer', 'correct', 'answer', 'correctIndex', 'correct_index', 'correctOption', 'correct_option', 'ans', 'correctans', 'right', 'key'],
    explanation: ['explanation', 'solution', 'rationale', 'explain', 'desc', 'description', 'reason', 'answer_explanation'],
    images: ['images', 'question_images', 'questionImages', 'image', 'img', 'imgs', 'media_images'],
    explanationImages: ['explanation_images', 'explanationImages', 'solution_images', 'answer_images'],
    videos: ['video', 'videos', 'video_url', 'videoUrl', 'hls', 'media_video'],
    audio: ['audio', 'audios', 'audio_url', 'audioUrl', 'sound'],
    media: ['media', 'attachments', 'assets'],
    tags: ['tags', 'tag', 'subject', 'topic', 'topics', 'category', 'categories', 'chapter', 'subtopic', 'labels'],
  };

  /**
   * First present, non-empty value among candidate keys (case-insensitive).
   * @param {any} obj @param {string[]} keys @returns {any}
   */
  function pick(obj, keys) {
    const lowerMap = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
    for (const k of keys) {
      const real = lowerMap.get(k.toLowerCase());
      if (real == null) continue;
      const v = obj[real];
      if (v != null && v !== '') return v;
    }
    return undefined;
  }

  /**
   * Coerce a value into an array of URLs (handles strings, arrays, objects).
   * @param {any} v @returns {string[]}
   */
  function toUrlList(v) {
    if (!v) return [];
    const out = [];
    const push = (x) => {
      if (!x) return;
      if (typeof x === 'string') out.push(x);
      else if (typeof x === 'object') {
        const u = x.url || x.src || x.href || x.uri || x.link || x.data;
        if (u) out.push(String(u));
      }
    };
    if (Array.isArray(v)) v.forEach(push);
    else push(v);
    return out.filter(Boolean);
  }

  /**
   * Normalize options into `[{ text, html, isCorrect }]`.
   * @param {any} raw @returns {{ options: {text:string, html:string, isCorrect:boolean}[], correctFromFlag: number }}
   */
  function normalizeOptions(raw) {
    const options = [];
    let correctFromFlag = -1;
    const add = (text, isCorrect = false) => {
      const html = text == null ? '' : String(text);
      options.push({ text: stripHtml(html), html, isCorrect: !!isCorrect });
      if (isCorrect && correctFromFlag < 0) correctFromFlag = options.length - 1;
    };
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (item == null) add('');
        else if (typeof item === 'string' || typeof item === 'number') add(String(item));
        else if (typeof item === 'object') {
          const text = item.text ?? item.option ?? item.value ?? item.label ?? item.title ?? item.answer ?? item.html ?? item.content ?? '';
          const isCorrect = item.isCorrect === true || item.correct === true || item.is_correct === true || item.right === true || item.answer === true;
          add(text, isCorrect);
        }
      }
    } else if (raw && typeof raw === 'object') {
      for (const [, val] of Object.entries(raw)) {
        if (val && typeof val === 'object') add(val.text ?? val.value ?? val.label ?? '', val.correct === true || val.isCorrect === true);
        else add(String(val));
      }
    }
    return { options, correctFromFlag };
  }

  /**
   * Resolve a correct-answer index from many possible encodings.
   * @param {any} correctRaw @param {{text:string,html:string,isCorrect:boolean}[]} options @param {number} correctFromFlag @returns {number}
   */
  function resolveCorrect(correctRaw, options, correctFromFlag) {
    if (correctFromFlag >= 0) return correctFromFlag;
    if (correctRaw == null) return -1;
    if (typeof correctRaw === 'number') {
      if (correctRaw >= 0 && correctRaw < options.length) return correctRaw;
      if (correctRaw - 1 >= 0 && correctRaw - 1 < options.length) return correctRaw - 1;
      return -1;
    }
    if (Array.isArray(correctRaw)) {
      const idx = correctRaw.findIndex((x) => x === true || x === 1 || x === 'true');
      if (idx >= 0) return idx;
      if (correctRaw.length) return resolveCorrect(correctRaw[0], options, -1);
      return -1;
    }
    const s = String(correctRaw).trim();
    if (/^[A-Za-z]$/.test(s)) {
      const idx = s.toUpperCase().charCodeAt(0) - 65;
      if (idx >= 0 && idx < options.length) return idx;
    }
    if (/^\d+$/.test(s)) return resolveCorrect(Number(s), options, -1);
    const norm = (x) => stripHtml(x).toLowerCase().trim();
    const target = norm(s);
    const byText = options.findIndex((o) => norm(o.html) === target || norm(o.text) === target);
    if (byText >= 0) return byText;
    return -1;
  }

  /**
   * Normalize a single raw question object into canonical form.
   * @param {any} raw @param {number} index @returns {import('./quiz.js').Question | null}
   */
  function normalizeQuestion(raw, index) {
    if (!raw || typeof raw !== 'object') return null;

    const qHtml = pick(raw, FIELDS.question);
    const rawOptions = pick(raw, FIELDS.options);
    const { options, correctFromFlag } = normalizeOptions(rawOptions);

    const correctRaw = pick(raw, FIELDS.correct);
    const correctAnswer = resolveCorrect(correctRaw, options, correctFromFlag);

    const explanation = pick(raw, FIELDS.explanation);

    const images = [
      ...toUrlList(pick(raw, FIELDS.images)),
      ...toUrlList(pick(raw, FIELDS.explanationImages)),
      ...toUrlList(pick(raw, FIELDS.media)).filter((u) => /\.(png|jpe?g|gif|webp|svg)|image|base64|data:image/i.test(u)),
    ];
    const videos = [
      ...toUrlList(pick(raw, FIELDS.videos)),
      ...toUrlList(pick(raw, FIELDS.media)).filter((u) => /\.(mp4|m3u8|webm|mov)|youtube|vimeo|iframe|hls/i.test(u)),
    ];
    const audio = toUrlList(pick(raw, FIELDS.audio));

    let tags = pick(raw, FIELDS.tags);
    if (typeof tags === 'string') tags = tags.split(/[,;|]/).map((t) => t.trim()).filter(Boolean);
    else if (Array.isArray(tags)) tags = tags.map((t) => (typeof t === 'object' ? t.name || t.title || '' : String(t))).filter(Boolean);
    else tags = [];

    const questionHtml = qHtml == null ? '' : String(qHtml);
    const plain = stripHtml(questionHtml);
    if (!plain && options.length === 0) return null;

    const id = raw.id != null ? String(raw.id) : `${hash(plain + '|' + options.map((o) => o.text).join('|'))}_${index}`;

    return {
      id,
      question: plain,
      html: questionHtml,
      options,
      correctAnswer,
      explanation: explanation == null ? '' : String(explanation),
      explanationHtml: explanation == null ? '' : String(explanation),
      images: Array.from(new Set(images)),
      videos: Array.from(new Set(videos)),
      audio: Array.from(new Set(audio)),
      tags: Array.from(new Set(tags)),
      raw,
    };
  }

  /**
   * Normalize an entire bank into `{ questions: [] }`.
   * @param {any[]} bank @returns {{ questions: import('./quiz.js').Question[] }}
   */
  function normalizeBank(bank) {
    const questions = [];
    const seen = new Set();
    (bank || []).forEach((raw, i) => {
      const q = normalizeQuestion(raw, i);
      if (!q) return;
      const sig = hash(q.question + '::' + q.options.map((o) => o.text).join('|'));
      if (seen.has(sig)) return;
      seen.add(sig);
      questions.push(q);
    });
    return { questions };
  }

  /**
   * Accept an already-canonical payload (imported session) and conform it.
   * @param {any} data @returns {{ questions: import('./quiz.js').Question[] }}
   */
  function normalizeImported(data) {
    const arr = Array.isArray(data) ? data : Array.isArray(data?.questions) ? data.questions : [];
    const looksCanonical = arr.length > 0 && arr[0] && Array.isArray(arr[0].options) && 'correctAnswer' in arr[0];
    if (looksCanonical) {
      return {
        questions: arr.map((q, i) => ({
          id: q.id || String(i),
          question: q.question || stripHtml(q.html || ''),
          html: q.html || q.question || '',
          options: (q.options || []).map((o) => (typeof o === 'string' ? { text: stripHtml(o), html: o, isCorrect: false } : o)),
          correctAnswer: typeof q.correctAnswer === 'number' ? q.correctAnswer : -1,
          explanation: q.explanation || '',
          explanationHtml: q.explanationHtml || q.explanation || '',
          images: q.images || [],
          videos: q.videos || [],
          audio: q.audio || [],
          tags: q.tags || [],
          raw: q.raw || q,
        })),
      };
    }
    return normalizeBank(arr);
  }

  DAMS.normalizer = { normalizeQuestion, normalizeBank, normalizeImported };
})(window.DAMS = window.DAMS || {});
