# DAMS Universal Extractor

Load **any** DAMS HTML quiz file completely offline and convert it into a
universal quiz format — regardless of DAMS version (Bootcamp, DVT, T&D, BTR, RR,
GT, PYQ, or any future build that follows a similar architecture).

You pick a DAMS `.html` file; the app discovers the question bank **by structure**,
not by variable name, and turns it into a clean, portable format you can quiz
against, search, and export to Anki.

- **100% offline.** No backend, no server, no build step, no runtime Node. Your
  file never leaves the browser.
- **Version-agnostic.** It does **not** rely on fixed names like `questions`,
  `quizData`, `ALL_QUESTIONS`, or `QUESTION_BANK`. It finds the bank dynamically.
- **Robust.** Ten independent extraction strategies run and their results are
  merged, so extraction rarely fails after a single attempt.

---

## Quick start

Just open **`index.html`** in a modern browser (Chrome, Edge, Firefox, Safari).
The app is built from **classic scripts** (no ES modules) specifically so it runs
straight from disk (`file://`) — no local server required.

> Prefer a server? Any static server works, e.g. `npx http-server` or
> `python3 -m http.server`. Serving over `http://` is required only if you want
> to load a DAMS file that pulls in **external** `<script src="…">` bundles; inline
> scripts (the vast majority of DAMS exports) work fine from `file://`.

Then:

1. Drop a DAMS `.html` file onto the drop zone (or click to choose one).
2. Watch the extraction log discover the bank.
3. Quiz, search, and export.

No file handy? Click **“Try a sample deck.”**

---

## Folder structure

```
dams-universal/
├── index.html            # UI shell
├── README.md
├── css/
│   └── style.css         # Responsive, dark-mode-aware styling (no framework)
├── vendor/
│   └── acorn.js          # Optional real AST parser (auto-detected)
└── js/
    ├── utils.js          # Shared helpers + Emitter + safe deep-walk
    ├── storage.js        # localStorage persistence (bookmarks, progress, stats)
    ├── loader.js         # File API reading + HTML/script splitting
    ├── sandbox.js        # Instrumented isolated execution + postMessage harvest
    ├── extractor.js      # Scoring heuristics + AST/tokenizer literal scanning
    ├── normalizer.js     # Any question shape → canonical shape
    ├── parser.js         # Orchestrates all strategies, merges results
    ├── quiz.js           # Quiz engine (navigation, filters, timer, stats)
    ├── anki.js           # Anki card builders (basic/cloze/image, TSV/CSV/JSON)
    ├── export.js         # Universal JSON, Anki, session export/import
    ├── search.js         # Instant field-weighted full-text search
    └── app.js            # DOM controller wiring everything together
```

All modules publish onto a single global namespace, `window.DAMS`
(`DAMS.utils`, `DAMS.parser`, `DAMS.quiz`, …). Scripts are loaded in dependency
order at the bottom of `index.html`.

---

## Architecture

### The extraction pipeline

```
File → loader → parser ──► sandbox (runtime strategies)  ─┐
                     └────► extractor (static strategies) ─┴─► candidate banks
                                                              │
                              normalizer ◄────────────────────┘
                                    │
                                    ▼
                        { questions: [ canonical … ] } → quiz engine → UI
```

The **parser** (`parser.js`) is the orchestrator. It runs the runtime strategies
inside the **sandbox**, runs the static strategies via the **extractor**, merges
every high-confidence *candidate bank* it finds, de-duplicates by content, and
hands the result to the **normalizer**.

### Why structure, not names

DAMS builds change variable names between versions and courses. Instead of
looking for a known identifier, every candidate object is **scored** by the
fields it contains (`question`/`text`/`stem`, `options`/`choices`, `correct`/
`answer`, `explanation`/`solution`, …). An array is treated as a question bank
when enough of its elements score highly. This is implemented once in
`extractor.js` (`scoreQuestion` / `scoreArray`) and mirrored inside the sandbox
instrumentation (which is stringified and injected, so it must be
self-contained).

### The ten strategies

Runtime strategies run **inside an isolated blob iframe** (`sandbox.js`). The
iframe is `sandbox="allow-scripts"` — a unique opaque origin that cannot touch
the app's DOM or storage — and results are returned exclusively via
`postMessage`, which is why extraction works even from `file://` (where direct
cross-origin `contentWindow` access would throw).

| # | Strategy | Where | Catches |
|---|----------|-------|---------|
| 1 | Sandbox execution | sandbox | Banks built at runtime |
| 2 | AST / tokenizer literal scan | extractor (parent) | `const`/`let`/closure/IIFE banks never exposed globally |
| 3 | Recursive object discovery | sandbox | Nested banks inside config objects, Maps, Sets |
| 4 | Function-result capture | sandbox | Factory functions returning banks |
| 5 | Global-assignment snapshot | sandbox | `var` / `window.x = …` banks under any name |
| 6 | MutationObserver | sandbox | DOM-rendered question text |
| 7 | Monkey-patch `Array.prototype.push` | sandbox | Banks assembled via repeated `.push()` |
| 8 | Monkey-patch `fetch` / `XMLHttpRequest` | sandbox | Banks loaded from embedded data URLs |
| 9 | Monkey-patch `JSON.parse` | sandbox | Banks stored as a JSON string blob |
| 10 | Hook `Object.defineProperty` | sandbox | Banks defined via property descriptors |

Every strategy contributes candidates; the parser **merges them all** and
de-duplicates, so a file that hides its bank three different ways still yields
one clean, complete deck.

### Static scanning without regex-parsing code

Strategy 2 does **not** regex over source to find literals (brackets inside
strings would break that). Instead `extractor.js`:

1. builds a character-level **code mask** (`maskCode`) that marks which
   characters are real code vs. inside a string/template/comment;
2. finds **balanced** `[...]` array spans using that mask;
3. evaluates promising spans in a guarded `Function` sandbox to materialize the
   data.

If `vendor/acorn.js` is present, a real AST walk (`ArrayExpression` nodes) is
used instead for precision; the tokenizer is the dependency-free fallback.

### Canonical question shape

Every extracted question — whatever its original shape — becomes:

```js
{
  id, question, html, options: [{ text, html, isCorrect }],
  correctAnswer,           // zero-based index, or -1 if not encoded
  explanation, explanationHtml,
  images: [], videos: [], audio: [], tags: [], raw
}
```

The normalizer resolves the correct answer whether it was stored as an index
(0- or 1-based), a letter (`"B"`), the answer text, a boolean flag on an option,
or a boolean array.

---

## Features

- **Quiz engine** — Previous / Next / Jump / Random, bookmarks, mark-for-review,
  shuffle, and filter modes: **All, Bookmarks, Review, Weak, Incorrect,
  Unanswered**. Progress bar, live statistics, and a session timer.
- **Instant search** (`Ctrl/Cmd-K`) across question text, options, correct
  answer, tags, and explanation, ranked by field weight.
- **Media** — renders images (data URI / base64 / blob / relative / absolute),
  `<video>`/`<audio>`, HLS (`.m3u8`), and iframe/embedded video.
- **Anki export** — Basic, Cloze, and Image cards as **TSV, CSV, or JSON**, with
  **All / Weak-only / Incorrect-only / Bookmarked** subsets.
- **Universal export & re-import** — export the quiz as universal JSON, or a full
  session (deck + progress) that can be loaded straight back in.
- **Local storage** — bookmarks, progress, last question, weak areas, and stats
  are saved automatically per deck.
- **Debug panel** (🐞 in the header) — discovered globals, largest arrays,
  ranked candidate banks, runtime capture counts, execution log, and errors.
- **Dark mode**, full keyboard control, and responsive layout for desktop,
  tablet, and phone.

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `←` / `→` | Previous / Next question |
| `1`–`9` | Select that option |
| `B` | Toggle bookmark |
| `M` | Toggle mark-for-review |
| `Ctrl/Cmd-K` | Open search |
| `Esc` | Close overlay / search |

---

## Adding a new extraction strategy

The design is intentionally open for extension.

**A new *static* strategy** (operates on raw source): add a function to
`extractor.js` that returns an array of candidates in the shape
`{ data: any[], score: number, count: number, source: string }`, then call it
from `parser.js` alongside `scanObjectLiterals` and concatenate its results into
`candidates`. Reuse `scoreArray` so your candidates rank consistently.

**A new *runtime* strategy** (needs the DAMS code to execute): add it to the
`INSTRUMENTATION` function inside `sandbox.js`. Because that function is
serialized with `.toString()` and injected into the iframe, it must stay
self-contained (no references to module scope). Push anything interesting into a
new `cap.*` buffer, then include that buffer in the `harvest()` sweep so it is
scored and posted back. The parser and normalizer need no changes — new banks
flow through the existing merge/dedupe path automatically.

**A new question field name**: add the alias to the relevant list in
`normalizer.js` (`FIELDS`) and, if it is a *signal* field, to `QUESTION_KEYS` in
`extractor.js` (and the mirrored `QKEYS` in `sandbox.js`) so detection improves.

---

## Notes & limitations

- The extractor **executes** the DAMS file's inline JavaScript to observe how it
  builds its bank. That code runs in a sandboxed, isolated iframe, but you should
  still only open files you trust.
- **External** `<script src="…">` bundles cannot be fetched offline and are
  skipped; inline scripts (how DAMS ships its questions) are fully supported.
  Load such a file over a static server if its bank lives in an external bundle.
- Answer keys are extracted only when the source encodes them; questions without
  an encoded key are shown and exported, flagged as having no key.

---

## Tech

Pure HTML + CSS + vanilla JavaScript (ES2023, strict mode, JSDoc-annotated).
No React/Vue/Angular, no bundler, no runtime dependencies. The only vendored
file is the optional `acorn` parser, and the app degrades gracefully without it.
