# Migration Checklist — Embedding into Kairos AI

A concrete, ordered checklist for turning the standalone DAMS Universal Extractor
into an embedded component inside Kairos AI. Grouped by phase. Nothing here adds
user-facing features; it is integration plumbing on top of the stabilized
architecture.

Legend: ☐ = to do.

---

## Phase 0 — Prerequisites (done in this stabilization pass)

- ☑ Business logic separated from UI (subsystems vs. `app.js`).
- ☑ Extractor separated from quiz engine; parser separated from storage.
- ☑ Public protocols defined (`core/interfaces.js`).
- ☑ Single composition root with dependency injection (`core/engine.js`).
- ☑ Storage behind `StorageAdapter`; `LocalStorageAdapter` + `MemoryStorageAdapter`.
- ☑ Pure export serializers separated from download side effects.
- ☑ Independent test suite + benchmarks + memory profiling.
- ☑ Standalone app still fully functional; backward compatibility preserved.

## Phase 1 — Decide the embedding model

- ☐ Choose Option A (headless engine + native UI), B (full web UI), or C
  (native UI + extraction service). See `INTEGRATION_KAIROS.md`.
- ☐ Confirm extraction runs in a `WKWebView` (required — it executes DAMS JS).
- ☐ Decide where normalized questions live (web view vs. native store).

## Phase 2 — Package the web assets into the app bundle

- ☐ Add `dams-universal/` (or a trimmed subset) to the iOS app bundle as
  resources. For headless (Option A/C) you can ship a minimal shell that loads
  only: `vendor/acorn.js`, `js/utils.js`, `js/core/interfaces.js`,
  `js/adapters/storage.adapter.js`, `js/storage.js`, `js/loader.js`,
  `js/extractor.js`, `js/normalizer.js`, `js/sandbox.js`, `js/quiz.js`,
  `js/search.js`, `js/anki.js`, `js/export.js`, `js/parser.js`,
  `js/core/engine.js`. (Skip `app.js` and `css/` unless you want the UI.)
- ☐ Verify script load order matches `index.html`.
- ☐ Load via `loadFileURL(_:allowingReadAccessTo:)` so relative script paths and
  the sandbox blob iframe resolve.

## Phase 3 — Establish the Swift ↔ JS bridge

- ☐ Register `WKScriptMessageHandler`s (e.g. `result`, `stats`, `storage`).
- ☐ Implement `evaluateJavaScript` calls for: extract, createQuiz, answer/next/
  filter, search, export.
- ☐ Marshal DAMS file contents into JS safely (escape, or write to a temp file
  the web view can read).
- ☐ Always consume extraction as a Promise/message (it is async).

## Phase 4 — Wire native storage (if not using Option B default)

- ☐ Implement a `StorageAdapter` in JS backed by native message handlers.
- ☐ Ensure `get`/`keys` return synchronously (warm cache if the native side is
  async).
- ☐ Pass it as `DAMS.createEngine({ storage })`; confirm it passes the protocol
  assertion (fails loudly if a method is missing).
- ☐ Namespacing: keep the `dams-universal:` key prefix or set your own on the
  adapter.

## Phase 5 — Map data + persistence

- ☐ Map the canonical question shape (`ARCHITECTURE.md §4.2`) to Kairos' model.
- ☐ Decide export destinations (Files app, share sheet, iCloud) and call
  `engine.exporter.*` (returns `{ filename, mime, content }`) — no browser
  download involved.
- ☐ Reuse `engine.exporter.parseSession` / `normalizeImported` for re-import.

## Phase 6 — Security & privacy review

- ☐ Confirm the extraction iframe keeps `sandbox="allow-scripts"` (no
  `allow-same-origin`).
- ☐ Block remote navigation in the `WKWebView`; no outbound network at runtime.
- ☐ Treat all input files as untrusted; validate size/type before extraction.
- ☐ Confirm nothing from a DAMS file can reach native handlers except the
  sanitized `postMessage` result.

## Phase 7 — Performance & resource budgets

- ☐ Run `test/bench.js` on target hardware; record normalize/index/export times.
- ☐ Run extraction off the main actor; surface progress via `onProgress`.
- ☐ Set a timeout/expectation for very large DAMS files (sandbox has an internal
  timeout already).
- ☐ Watch heap on 10k-question decks (~18 MB delta in benchmarks).

## Phase 8 — Testing & CI

- ☐ Add `node test/run.mjs` (headless Playwright) to CI; gate on exit code.
- ☐ Add a smoke test that loads the bundled shell in a `WKWebView` and extracts a
  known fixture, asserting question count.
- ☐ Add regression fixtures for each DAMS version you support (Bootcamp, DVT,
  T&D, BTR, RR, GT, PYQ) once real samples are available.

## Phase 9 — Rollout

- ☐ Feature-flag the extractor entry point in Kairos.
- ☐ Ship to internal testers; collect debug reports via the existing debug
  payload (`report.debug`).
- ☐ Keep the standalone `index.html` as the developer test harness for new DAMS
  formats before they reach the app.

---

## Backward-compatibility guarantees to preserve

- `DAMS.storage.Storage`, `new Quiz(questions, deckId)`, `DAMS.parser.extract`,
  and `DAMS.exporter.export*` keep their existing signatures and behavior.
- `DAMS.createEngine` is additive; existing globals continue to work.
- Universal JSON and session JSON formats are versioned (`meta.version`); bump
  the version before any breaking change and handle both on import.
