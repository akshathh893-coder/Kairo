# Architecture — DAMS Universal Extractor

This document describes every subsystem, how they are wired, and the rules that
keep them decoupled. It reflects the **stabilization architecture**: business
logic is separated from UI, each subsystem sits behind a protocol, dependencies
are injected through a single composition root, and every module is
independently testable.

---

## 1. Layering

```
┌──────────────────────────────────────────────────────────────────┐
│  UI / Host layer                                                   │
│    app.js (standalone browser UI)   ·   Kairos AI (iOS/WKWebView)  │
└───────────────▲───────────────────────────────▲───────────────────┘
                │ uses one engine instance       │ uses one engine instance
┌───────────────┴───────────────────────────────┴───────────────────┐
│  Composition root                                                  │
│    core/engine.js  →  DAMS.createEngine(config)                    │
│    (dependency injection; returns protocol-conforming facades)     │
└───────────────▲───────────────────────────────────────────────────┘
                │ wires
┌───────────────┴───────────────────────────────────────────────────┐
│  Subsystems (business logic, no DOM/UI, no global state)           │
│    extractor · parser · sandbox · normalizer · quiz · search       │
│    anki · export                                                   │
└───────────────▲───────────────────────────────────────────────────┘
                │ depends on
┌───────────────┴───────────────────────────────────────────────────┐
│  Adapters + protocols                                              │
│    core/interfaces.js (protocols)                                  │
│    adapters/storage.adapter.js (LocalStorage/Memory + SessionStore)│
└───────────────▲───────────────────────────────────────────────────┘
                │ depends on
┌───────────────┴───────────────────────────────────────────────────┐
│  Foundation                                                        │
│    utils.js (Emitter, DOM helpers, deep-walk, hashing, …)          │
└────────────────────────────────────────────────────────────────────┘
```

**Rule:** a layer may depend only on the layers below it. Subsystems never reach
into the UI; the UI reaches subsystems **only** through the engine facades.

All modules are classic scripts that publish onto a single global namespace,
`window.DAMS`. This is deliberate: it lets the whole project run by opening
`index.html` from disk (ES modules are blocked on `file://`) and makes the
surface trivial to expose inside a WKWebView. Load order is fixed in
`index.html` and mirrors the layering above.

---

## 2. Protocols (`core/interfaces.js`)

JavaScript has no native interfaces, so a **Protocol** is a named list of
required methods plus a runtime validator. Six public protocols define every
integration boundary:

| Protocol | Required methods | Implemented by |
|----------|------------------|----------------|
| `StorageAdapter` | `get, set, remove, clear, keys` | `LocalStorageAdapter`, `MemoryStorageAdapter`, host adapters |
| `Extractor` | `extract, extractFromHtml` | engine `extractor` facade |
| `QuizEngine` | `current, next, prev, jumpTo, answer, setFilter, stats, on` | `Quiz` |
| `SearchEngine` | `search` | `SearchIndex` |
| `FlashcardEngine` | `build, toTSV, toCSV, toJSON` | engine `flashcards` facade |
| `Exporter` | `universalJSON, anki, session, parseSession` | engine `exporter` facade |

`Protocol.assert(obj)` throws a descriptive error listing missing methods. The
engine asserts conformance for every facade at composition time, and tests use
`Protocol.isImplementedBy` to verify adapters and facades structurally. This is
how "every module communicates only through protocols" is enforced without a
type checker.

---

## 3. Composition root (`core/engine.js`)

`DAMS.createEngine(config)` is the single wiring path and the **public API**.

```js
const engine = DAMS.createEngine({ storage /* optional StorageAdapter */ });

engine.storage        // the StorageAdapter in use
engine.sessions       // SessionStore over that adapter
engine.extractor      // Extractor:   extract(File|string|LoadedFile), extractFromHtml(raw)
engine.createQuiz(qs, deckId)   // → QuizEngine
engine.createSearch(qs)         // → SearchEngine
engine.flashcards     // FlashcardEngine
engine.exporter       // Exporter (pure serializers → { filename, mime, content })
engine.deckIdFor(qs, name)
engine.version
```

Dependency injection happens here:

- **Storage** — if `config.storage` is supplied it is protocol-checked and used;
  otherwise the engine picks `LocalStorageAdapter` in a browser or
  `MemoryStorageAdapter` when no `localStorage` exists (headless/tests). The quiz
  engine only ever sees a `SessionStore`, never a concrete backend.
- **Parser collaborators** — `config.parserDeps` can replace the sandbox,
  extractor, or normalizer functions (used to stub the sandbox in tests).

Both the standalone UI (`app.js`) and the host build themselves on an engine
instance, so there is exactly one place where subsystems are connected.

---

## 4. Subsystems

### 4.1 Extractor pipeline — `loader` → `parser` (+ `sandbox`, `extractor`)

- **`loader.js`** — reads a `File` (or raw string) via the File API and splits it
  into a `LoadedFile` (DOM, inline `<script>` bodies, external src list). It never
  executes code.
- **`sandbox.js`** — runs the file's inline scripts inside an isolated
  `sandbox="allow-scripts"` blob iframe with instrumentation installed first
  (monkey-patched `Array.push` / `JSON.parse` / `fetch`+XHR /
  `Object.defineProperty`, global-diff snapshot, MutationObserver, recursive
  discovery). Results are JSON-sanitized and returned via `postMessage`, so it
  works from `file://` and cannot touch the host DOM/storage.
- **`extractor.js`** — structural scoring (`scoreQuestion` / `scoreArray`) plus
  the static AST/tokenizer literal scan (Acorn if present, hand-written
  string-aware tokenizer otherwise) that catches `const`/`let`/closure/IIFE banks.
- **`parser.js`** — orchestrates the ten strategies, merges every high-confidence
  candidate bank, de-duplicates, and hands off to the normalizer. Collaborators
  are injectable (`resolveDeps`) so the pipeline is testable without a real
  sandbox.

The scoring heuristic is duplicated (deliberately) inside the sandbox
instrumentation because that code is stringified and injected, and must stay
self-contained.

### 4.2 Normalizer — `normalizer.js`

Pure transformation: any question shape → the canonical shape

```js
{ id, question, html, options:[{text,html,isCorrect}], correctAnswer,
  explanation, explanationHtml, images, videos, audio, tags, raw }
```

Resolves the correct answer from an index (0/1-based), a letter, the answer text,
or a boolean flag/array. De-duplicates by content signature. No DOM UI, no state.

### 4.3 Quiz engine — `quiz.js`

Stateful session over a deck. Owns navigation, answering, bookmarks,
mark-for-review, filters (all/bookmarks/review/weak/incorrect/unanswered),
shuffle, timer and statistics. Extends `Emitter` and broadcasts `change`,
`answered`, `stats`, `tick`, etc. **Persistence is injected**: the constructor
takes `{ storage }` (a `SessionStore`) and defaults to the global one for
backward compatibility. It never references `localStorage`.

### 4.4 Search engine — `search.js`

Read-only. Builds a per-deck token index over question/options/answer/tags/
explanation and ranks by field-weighted term frequency with AND semantics.

### 4.5 Flashcard engine — `anki.js`

Builds Basic / Cloze / Image cards and serializes to TSV / CSV / JSON. Pure.

### 4.6 Export — `export.js`

Split into **pure serializers** (`universalArtifact`, `ankiArtifact`,
`sessionArtifact`, `parseSession`) returning `{ filename, mime, content }`, and
thin **download wrappers** that add the browser side effect. The engine's
`Exporter` facade exposes only the pure serializers, so a host can persist
artifacts however it wants.

### 4.7 Storage — `adapters/storage.adapter.js`, `storage.js`

`StorageAdapter` implementations plus `SessionStore` (owns the persisted session
shape). `storage.js` is now only a backward-compatible default
(`DAMS.storage.Storage = new SessionStore(new LocalStorageAdapter())`).

### 4.8 Foundation — `utils.js`

`Emitter`, DOM builders, `escapeHtml`/`stripHtml`, `hash`, `deepWalk`,
`safeStringify`, timing/format helpers. The only module allowed to touch the DOM
for helper purposes.

---

## 5. State & coupling rules

- **No cross-subsystem globals.** The only global is the `DAMS` namespace used for
  script registration; runtime state (sessions, decks) lives in injected objects.
- **Storage is injected**, never imported, by the quiz engine.
- **Parser collaborators are injected** (with defaults).
- **UI depends on the engine only**, never on individual subsystems' internals
  (it still uses `DAMS.exporter.export*` download wrappers, which are UI helpers).
- **Untrusted code is isolated** in the sandbox iframe and communicates only via
  `postMessage`.

---

## 6. Testing & performance

- `test/harness.js` — 30 unit/protocol/integration tests; every subsystem is
  built with a `MemoryStorageAdapter` and exercised without the UI.
- `test/bench.js` — benchmarks + stress tests at 10 / 100 / 1000 / 10000
  questions with `performance.memory` heap profiling and loose regression
  budgets.
- `test/run.mjs` — headless Playwright driver; exits non-zero on any failure.

Known characteristic: `Quiz.answer()` recomputes aggregate correctness in O(n)
over answered questions, so answering an entire 10k deck is O(n²). This is
correct and well within budget for realistic decks; it is surfaced by the
benchmark intentionally and is a candidate for a running-counter optimization if
very large single-session decks become common.

---

## 7. Extending

- **New extraction strategy** — add to `extractor.js` (static) or the sandbox
  instrumentation (runtime); return `{ data, score, count, source }` candidates.
  Parser/normalizer need no changes.
- **New storage backend** — implement the five `StorageAdapter` methods and pass
  it as `config.storage`. Nothing else changes.
- **New export format** — add a pure serializer to `export.js` and expose it on
  the `Exporter` facade.
- **New question field alias** — add it to `normalizer.js` `FIELDS` and, if it is
  a detection signal, to `QUESTION_KEYS` (and the mirrored `QKEYS` in
  `sandbox.js`).
