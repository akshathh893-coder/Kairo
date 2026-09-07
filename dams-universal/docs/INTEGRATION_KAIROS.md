# Integration Guide — Embedding into Kairos AI (iOS)

This guide explains how the DAMS Universal Extractor becomes an **embeddable
component** inside the existing Kairos AI iOS application. It is written against
the stabilization architecture: one public entry point (`DAMS.createEngine`),
protocol-based boundaries, injectable storage, and pure serializers.

The extractor is intentionally UI-agnostic. Kairos can embed it at three levels;
pick the one that matches how much of the standalone experience you want.

---

## Embedding options

### Option A — Headless engine in a `WKWebView` (recommended)

Run the engine's JavaScript in an off-screen `WKWebView` and drive it from Swift.
Kairos owns the native UI; the web view is a pure compute + extraction surface.
This keeps the one part that genuinely needs a browser — the sandboxed
extraction (it executes arbitrary DAMS scripts in an isolated iframe) — inside a
real web runtime, while everything else is callable as data-in/data-out.

**Why a web view is required for extraction:** the extractor runs untrusted DAMS
JavaScript in a `sandbox="allow-scripts"` iframe and observes how it builds its
question bank. That needs a DOM + JS engine. A pure-Swift port cannot reproduce
the ten runtime strategies. Everything *after* extraction (normalized questions)
is plain JSON and can be handled natively if desired.

```
┌──────────────── Kairos AI (native) ────────────────┐
│  SwiftUI screens · storage · sync · navigation      │
│        │  evaluateJavaScript / message handlers      │
│  ┌─────▼──────────────── WKWebView ───────────────┐  │
│  │  index shell (no visible UI needed)            │  │
│  │  window.DAMS.createEngine({ storage: bridge }) │  │
│  │  sandboxed extraction iframe (opaque origin)   │  │
│  └────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### Option B — Full standalone UI in a `WKWebView`

Load `index.html` as-is inside a `WKWebView` and show it. Fastest path; you get
the entire quiz/search/export experience with zero native work. Inject a custom
storage adapter if you want progress to live in native storage.

### Option C — Native UI + engine-as-a-service

Same as A, but you also render questions natively (SwiftUI) and treat the web
view purely as an extraction/normalization service that returns Universal JSON.

---

## The contract Kairos codes against

Everything is reachable from `DAMS.createEngine(config)` (see
`ARCHITECTURE.md §3`). The host only needs these calls:

```js
const engine = DAMS.createEngine({ storage: hostStorageAdapter /* optional */ });

// 1. Extraction — returns normalized questions + a diagnostic report
const report = await engine.extractor.extract(fileOrHtmlString);
//   report.questions : canonical questions (plain JSON)
//   report.strategy, report.debug, report.log

// 2. Quiz session (optional if Kairos renders natively)
const quiz = engine.createQuiz(report.questions, deckId);
quiz.on('stats', s => bridge.post('stats', s));
quiz.answer(2); quiz.next(); quiz.setFilter('weak');

// 3. Search
const idx = engine.createSearch(report.questions);
idx.search('mitochondria');

// 4. Flashcards / Export (pure — return artifacts, no download)
engine.exporter.universalJSON(report.questions);
engine.exporter.anki(report.questions, { type: 'cloze', format: 'tsv' });
//   → { filename, mime, content }  — Kairos writes it wherever it wants
```

The canonical question shape is stable and documented in `ARCHITECTURE.md §4.2`.

---

## Injecting native storage

Kairos can persist quiz progress in its own store (files, Core Data, Keychain,
iCloud) by passing a `StorageAdapter`. The adapter is five methods:

```js
// Installed into the web view from Swift, then handed to createEngine:
const hostStorageAdapter = {
  get(key, fallback)  { const v = window.__native_get(key); return v == null ? fallback : JSON.parse(v); },
  set(key, value)     { window.webkit.messageHandlers.storage.postMessage({op:'set', key, value: JSON.stringify(value)}); return true; },
  remove(key)         { window.webkit.messageHandlers.storage.postMessage({op:'remove', key}); },
  clear()             { window.webkit.messageHandlers.storage.postMessage({op:'clear'}); },
  keys()              { return window.__native_keys() || []; },
};
const engine = DAMS.createEngine({ storage: hostStorageAdapter });
```

`createEngine` validates the adapter against the `StorageAdapter` protocol and
throws if a method is missing — so a broken bridge fails fast and loudly.

> Note: `get`/`keys` are synchronous in the protocol. If your bridge is
> async-only, back them with a small warm cache the message handler updates, or
> adopt Option B and let the default `LocalStorageAdapter` (WebKit-backed)
> persist inside the web view.

---

## Swift ↔ JS bridging sketch (Option A)

```swift
// 1. Load the shell
let config = WKWebViewConfiguration()
config.userContentController.add(self, name: "storage")   // native storage
config.userContentController.add(self, name: "result")    // extraction results
let webView = WKWebView(frame: .zero, configuration: config)
webView.loadFileURL(indexURL, allowingReadAccessTo: bundleRoot)

// 2. Extract a DAMS file the user picked
let escaped = damsHtml.jsEscaped()
webView.evaluateJavaScript("""
  DAMS.createEngine().extractor.extractFromHtml(\(escaped), 'deck.html')
    .then(r => window.webkit.messageHandlers.result.postMessage(JSON.stringify(r)));
""")

// 3. Receive normalized questions natively
func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
  if m.name == "result" { let report = decode(m.body as! String) /* render in SwiftUI */ }
}
```

Extraction runs asynchronously (it drives the sandbox iframe), so always consume
the returned Promise / message rather than a synchronous return value.

---

## Performance & memory expectations

From `test/bench.js` (Chromium, representative hardware):

| Deck size | Normalize | Index | Export | Heap Δ |
|-----------|-----------|-------|--------|--------|
| 100 | ~3 ms | <1 ms | <1 ms | ~0 |
| 1 000 | ~22 ms | ~3 ms | ~9 ms | ~2 MB |
| 10 000 | ~190 ms | ~33 ms | ~84 ms | ~18 MB |

On iOS, budget extraction (which executes the DAMS scripts) generously — it is
dominated by the DAMS file's own code, not ours. Run it off the main actor and
show progress via the `onProgress` callback the extractor already emits.

---

## Security

- DAMS scripts execute in a `sandbox="allow-scripts"` iframe (opaque origin) and
  return data only via `postMessage`; they cannot read the host page, cookies, or
  storage.
- Still treat input files as untrusted. In a `WKWebView`, disable navigation to
  remote origins and keep `allowsLinkPreview`/JS bridges minimal.
- No network access is required or used at runtime; the component is fully
  offline, which matches Kairos' privacy posture.

See `MIGRATION_CHECKLIST.md` for the concrete step-by-step embedding tasks.
