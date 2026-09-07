# Sequence Diagrams

Interaction flows across the subsystems. Rendered by GitHub; the raw `.mmd`
sources are in `docs/diagrams/` for other tooling.

---

## 1. Import (file / session in)

```mermaid
sequenceDiagram
    actor User
    participant Host as Host (app.js / Kairos)
    participant Engine as createEngine()
    participant Loader as loader.js
    participant Parser as parser.js

    User->>Host: choose .html or .session.json
    Host->>Engine: engine.extractor.extract(File)
    Engine->>Loader: loadFile(File)
    Loader->>Loader: readFileText + parseHtml
    alt session JSON
        Loader-->>Engine: LoadedFile{ isSessionJson, sessionData }
        Engine->>Parser: extract(loaded)
        Parser->>Parser: normalizeImported(sessionData)
        Parser-->>Engine: { questions, strategy:"session-import" }
    else DAMS HTML
        Loader-->>Engine: LoadedFile{ doc, scripts[] }
        Engine->>Parser: extract(loaded) (see Extraction)
    end
    Engine-->>Host: ExtractionReport
```

---

## 2. Extraction (ten strategies)

```mermaid
sequenceDiagram
    participant Parser as parser.js
    participant Sandbox as sandbox.js (blob iframe)
    participant Extractor as extractor.js
    participant Norm as normalizer.js

    Parser->>Sandbox: runInSandbox(loaded)
    activate Sandbox
    Note over Sandbox: install hooks BEFORE DAMS code<br/>push / JSON.parse / fetch / defineProperty
    Sandbox->>Sandbox: execute inline scripts (guarded)
    Sandbox->>Sandbox: harvest() — recursive scan + buffers
    Sandbox-->>Parser: postMessage { banks[], debug }
    deactivate Sandbox

    Parser->>Extractor: scanObjectLiterals(code)  %% Strategy 2 (AST/tokenizer)
    Extractor-->>Parser: candidate banks (const/closure/IIFE)

    Parser->>Extractor: dedupeCandidates(all)
    Parser->>Norm: normalizeBank(merged candidates)
    Norm-->>Parser: { questions[] }
    Parser-->>Parser: ExtractionReport{ questions, strategy, candidates, debug }
```

---

## 3. Normalization (per question)

```mermaid
sequenceDiagram
    participant Norm as normalizer.js
    participant Q as raw question (any DAMS shape)

    Norm->>Q: pick(question|stem|text|raw_text|…)
    Norm->>Q: pick(options|choices|opts|answers)
    Norm->>Norm: normalizeOptions → [{text,html,isCorrect}]
    Norm->>Q: pick(correct|answer|correctIndex|…)
    Norm->>Norm: resolveCorrect(index | letter | text | bool-flag | bool-array)
    Norm->>Q: pick(explanation|solution|rationale)
    Norm->>Q: collect images / videos / audio / tags
    Norm-->>Norm: canonical { id, question, options, correctAnswer, … }
    Note over Norm: drop empties · de-dupe by content signature
```

---

## 4. Quiz (answer a question)

```mermaid
sequenceDiagram
    actor User
    participant Host as UI / Host
    participant Quiz as QuizEngine
    participant Store as SessionStore
    participant Adapter as StorageAdapter

    Host->>Quiz: engine.createQuiz(questions, deckId)
    Quiz->>Store: loadSession(deckId)
    Store->>Adapter: get("session:deckId")
    Adapter-->>Store: persisted state (or default)
    Store-->>Quiz: state

    User->>Host: select option i
    Host->>Quiz: answer(i)
    Quiz->>Quiz: compare to correctAnswer · update stats / weak
    Quiz->>Store: saveSession(deckId, state)
    Store->>Adapter: set("session:deckId", state)
    Quiz-->>Host: emit "answered" + "stats"
    Host-->>User: reveal correctness + explanation
```

---

## 5. Export (deck / session out)

```mermaid
sequenceDiagram
    actor User
    participant Host as UI / Host
    participant Exporter as Exporter facade
    participant Anki as anki.js

    User->>Host: choose format (Universal / Anki / Session)
    alt Universal JSON
        Host->>Exporter: universalJSON(questions, meta)
        Exporter-->>Host: JSON string
    else Anki (basic/cloze/image · tsv/csv/json)
        Host->>Exporter: anki(questions, {type, format})
        Exporter->>Anki: buildCards + toTSV/CSV/JSON
        Anki-->>Exporter: cards → serialized
        Exporter-->>Host: { filename, mime, content }
    else Full session
        Host->>Exporter: session(quiz)
        Exporter-->>Host: { filename, mime, content } (deck + state)
    end
    Note over Host: standalone UI → downloadFile()<br/>Kairos host → write via bridge
    Host-->>User: file saved / shared
```
