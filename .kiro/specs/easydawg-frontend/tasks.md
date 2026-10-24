# Implementation Plan: EasyDawg Frontend

## Overview

This plan builds the zero-build, vanilla HTML/CSS/JS frontend for the EasyDawg essay reviewer. It starts with the dependency layer — faithful 1:1 JS ports of `router.ts`, `shape-classifier.ts`, and `evaluator.ts`, plus the demo mock invoker — then builds the pure/deterministic frontend logic (span location, highlight union-merge, label mapping) that carries the property tests, then the DOM rendering and pipeline wiring in `app.js`, and finally the `index.html` structure and `styles.css` presentation.

Every file is a static, no-build asset. `app.js` is loaded as a browser-native ES module (`<script type="module">`) and imports the ported modules and the mock directly. No Node runtime, package install, bundler, or transpiler runs at build or run time (_Requirements: 1.2, 1.3, 1.4_).

### Testing approach under the zero-build constraint

The environment has no Node/npm build step, so tests must be browser-loadable or standalone. Property-based tests and unit/integration tests are authored as a browser-loadable ES-module test harness: an HTML test page (`tests/index.html`) loads the ported modules, `app.js`'s exported pure functions, and **fast-check** as a static ES-module asset (e.g. a vendored `fast-check` ESM build or its CDN ESM entry referenced by URL — loaded as a static asset, no package install, per _Requirements 1.5_). The harness runs in the browser and prints pass/fail. Tests never ship with the demo page. Each property test runs a minimum of 100 iterations and is tagged `// Feature: easydawg-frontend, Property {n}: {text}`. The test harness files are outside the three-file demo surface and are development-only assets.

## Tasks

- [x] 1. Port the deterministic router module to a browser ES module
  - [x] 1.1 Create `router.js` as a 1:1 port of `router.ts`
    - Strip TypeScript types; preserve exact runtime logic of `evaluateProfile` and the private `addModifier` accumulation (sum when a key already exists).
    - Export `evaluateProfile` as a browser-native ES-module named export.
    - Preserve the exact modifier keys (`"Character"`, `"Contribution"`) and flag strings verbatim, and the exact conditional order.
    - Included for contract completeness even though this iteration never calls `evaluateProfile`.
    - _Requirements: 1.3, 1.4, 2.2_

- [x] 2. Port the shape-classifier module to a browser ES module
  - [x] 2.1 Port constants, types-free structures, and error classes of `shape-classifier.js`
    - Define `LLM_TIMEOUT_MS = 30000` and the `SYSTEM_PROMPT` string **verbatim**, character-for-character, from `shape-classifier.ts`.
    - Define error classes `EssayRequiredError`, `ClassificationFailedError`, `ClassificationTimeoutError`, `InvalidResponseError`, each setting `this.name` to its exact class-name string.
    - Export the error classes and `SYSTEM_PROMPT` so `app.js` can branch on `.name`/`instanceof`.
    - _Requirements: 1.3, 1.4, 2.2, 11.1, 12.2, 12.3, 12.4, 12.5_
  - [x] 2.2 Port the deterministic parse/validate stages of `shape-classifier.js`
    - Port `assertNonEmptyEssay`, `parseResponse`, `describeType`, `validateResult`, `buildMessages`, and the `ALLOWED_SHAPES`/`MAX_REASONING_LENGTH` constants with identical logic and identical error messages.
    - Preserve the strict no-coercion validation order: object → `shape` ∈ {linear, motif} → `circularity` strictly boolean → `reasoning` non-empty string ≤ 2000 chars.
    - _Requirements: 2.2, 11.3, 12.4_
  - [x] 2.3 Port the LLM seam and `classifyShape` pipeline of `shape-classifier.js`
    - Port the module-level `llmCall` throwing stub, `setLlmCall`, and `invokeLlm` with the `Promise.race` + `AbortController` 30s timeout and the exact failure mapping (timer → `ClassificationTimeoutError`, other → `ClassificationFailedError`, timeout passes through unchanged).
    - Port and export `classifyShape(essayText, invoker = invokeLlm)` running the exact stage order: `assertNonEmptyEssay` → `buildMessages` → `invoker(req, LLM_TIMEOUT_MS)` → `parseResponse` → `validateResult`.
    - Export `setLlmCall` so `app.js` can inject the mock before any stage runs.
    - _Requirements: 1.3, 1.4, 2.2, 6.1, 11.1, 12.2, 12.3, 12.4, 12.5_

- [x] 3. Port the evaluator module to a browser ES module
  - [x] 3.1 Port constants, `BASE_VALUES`, band structure, and error classes of `evaluator.js`
    - Define `LLM_TIMEOUT_MS = 30000`, `MAX_ESSAY_LENGTH = 20000`, `MAX_ATTEMPTS = 3`, `DIMENSION_KEYS` (canonical order), `BASE_VALUES` (`focus 25, specificity 25, character 20, how_you_think 20, contribution 15, self_awareness 10`), and the `SYSTEM_PROMPT` string **verbatim** from `evaluator.ts`.
    - Define error classes `EssayRequiredError`, `EvaluationFailedError`, `EvaluationTimeoutError`, `InvalidResponseError`, each setting `this.name` to its exact class-name string.
    - Export `BASE_VALUES`, `DIMENSION_KEYS`, the error classes, and `SYSTEM_PROMPT`.
    - _Requirements: 1.3, 1.4, 2.2, 7.2, 8.1, 11.1, 12.2, 12.3, 12.4, 12.5_
  - [x] 3.2 Port the seam, parse, and schema-validation stages of `evaluator.js`
    - Port the `llmCall` stub, `setLlmCall`, `invokeLlm` (30s `Promise.race` + `AbortController`; timer → `EvaluationTimeoutError`, other → `EvaluationFailedError`), `assertNonEmptyEssay` (empty/whitespace and `> MAX_ESSAY_LENGTH` → `EssayRequiredError`), `buildMessages` (`SHAPE:`/`ESSAY:` markers, verbatim essay body), `parseResponse`, `describeType`, `isPlainObject`, and `validateLlmEvaluation` with identical checks, order, and messages (exact-six-keys, no extra keys, per-dimension `score`/`span`/`reasoning`, strict-boolean `mechanics_pass`, mechanics consistency, `revisions` object shape, `claims` string array; `band` never read).
    - Export `setLlmCall`.
    - _Requirements: 2.2, 5.3, 5.4, 6.2, 11.1, 11.3, 12.2, 12.3, 12.4, 12.5_
  - [x] 3.3 Port the span/revision validation, deterministic scoring chain, and `evaluateEssay` retry loop
    - Port `validateSpansAndRevisions` (per-dimension `essayText.includes(span)`, exactly-three revisions, each `original` a substring; returns `{valid}` / `{valid,reason}`, never throws).
    - Port `scoreDimensions`, `applyProfileModifiers` (case-insensitive key match, add + clamp to `[0, BASE_VALUES[key]]`, preserve span/reasoning, pure/no-mutation), `computeTotalScore` (sum over `DIMENSION_KEYS`), `deriveBand` (inclusive thresholds `≤23→1, ≤46→2, ≤69→3, ≤92→4, else 5`).
    - Export `scoreDimensions`, `applyProfileModifiers`, `computeTotalScore`, `deriveBand` for direct property testing.
    - Port and export `evaluateEssay(essayText, profileModifiers, shape, invoker = invokeLlm)` with the `MAX_ATTEMPTS` loop retrying **only** on span/revision faults (JSON-syntax, schema, timeout, transport faults propagate immediately), then the once-only scoring chain and final `Evaluation_Result` assembly with computed `band`.
    - _Requirements: 2.2, 6.4, 6.5, 8.1, 8.2, 10.2, 10.3, 12.3, 12.4_
  - [ ]* 3.4 Write property test for the band derivation
    - **Property 1: Band is always an integer in 1–5**
    - Generate six per-dimension scores each in `[0, BASE_VALUES[key]]`; assert `deriveBand(computeTotalScore(dims))` is an integer in `[1, 5]`.
    - **Validates: Requirements 8.1**
  - [ ]* 3.5 Write property test for the total score
    - **Property 2: Total score equals the sum of the six dimension scores**
    - Generate six dimension scores; assert `computeTotalScore(dims)` equals the arithmetic sum of the six `score` values.
    - **Validates: Requirements 8.1, 8.2**
  - [ ]* 3.6 Write property test for empty-modifier invariance
    - **Property 11: Empty modifiers preserve base-value scores**
    - Generate a schema-valid dimension set; assert `applyProfileModifiers(dims, {})` leaves every dimension `score` equal to its input score.
    - **Validates: Requirements 6.4**
  - [ ]* 3.7 Write unit tests for band boundaries and scoring edges
    - Band boundary examples: totals `0→1, 23→1, 24→2, 46→2, 47→3, 69→3, 70→4, 92→4, 93→5, 115→5`.
    - `applyProfileModifiers` clamp edges and unmatched-key no-op; span/reasoning preserved.
    - _Requirements: 8.1_

- [x] 4. Build the demo mock LLM invoker and bundled sample data
  - [x] 4.1 Create `mock-llm.js` with the sample essay and hardcoded responses
    - Export the bundled sample essay string **verbatim** from the design Data Models section.
    - Export the mock classifier response `{ shape:"motif", circularity:true, reasoning:... }` and the mock evaluator response (six dimensions, `mechanics_pass:true`, empty `mechanics_errors`, exactly three revisions, two claims) **verbatim**, so every span and every revision `original` is an exact substring of the sample essay.
    - _Requirements: 11.4_
  - [x] 4.2 Implement the branching mock invoker
    - Export a single invoker `(req, timeoutMs) => Promise<string>` that returns JSON text: if `req.systemPrompt` contains the classifier markers (`"classify the structural SHAPE"` / `"SHAPE RULES"`) return the classifier response, otherwise (evaluator markers `"DIMENSIONS AND BASE VALUES"` / `"VERBATIM SPAN RULE"`) return the evaluator response.
    - Return schema-valid JSON strings so neither module raises `InvalidResponseError` and `validateSpansAndRevisions` accepts on the first attempt (no retry).
    - _Requirements: 11.1, 11.4_
  - [ ]* 4.3 Write mock self-consistency test
    - Assert all six evaluator spans and all three revision `original`s are exact substrings of the bundled sample essay, so the ported `validateSpansAndRevisions` accepts the mock evaluator response with no retry and no `InvalidResponseError`.
    - _Requirements: 11.4_

- [x] 5. Checkpoint — dependency layer complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement the pure frontend logic in `app.js`
  - [x] 6.1 Implement the dimension label map and gauge view-model helper
    - Add `DimensionLabelMap` (`focus→"Focus"`, …, `how_you_think→"How You Think"`, `self_awareness→"Self-Awareness"`) and a pure helper that maps an `Evaluation_Result.dimensions` entry + `BASE_VALUES[key]` to a gauge view model (`{ key, label, score, baseValue, reasoning, fillFraction: score/baseValue }`).
    - Export these helpers for direct unit testing.
    - _Requirements: 7.2, 7.3, 7.4, 7.5_
  - [x] 6.2 Implement span location and union-merge computation
    - Implement a pure `computeHighlightRanges(essayText, dimensions)`: for each of the six spans, find first occurrence via `indexOf` (case-sensitive, from index 0) → range `[i, i+span.length)`; `-1` means not located and is recorded as a dimension-associated "not located" result (no range produced).
    - Union-merge all located ranges into sorted non-overlapping `HighlightRange` objects `{ start, end, dimensions[] }` where a character is covered iff ≥1 span covers it; overlaps merge into one range carrying all contributing dimension keys.
    - Export `computeHighlightRanges` and return both the merged ranges and the list of not-located dimension keys.
    - _Requirements: 10.2, 10.3, 10.4, 10.5_
  - [x] 6.3 Implement the escape + backdrop-segment builder
    - Implement a pure `buildBackdropSegments(essayText, highlightRanges)` producing an ordered segment list of plain-text runs and highlighted runs, with all essay characters HTML-escaped and whitespace/line breaks preserved (consumed later with `white-space: pre-wrap`).
    - Each highlighted segment carries its contributing dimension keys for the accessible `aria-label` and the non-color indicator.
    - Export `buildBackdropSegments`.
    - _Requirements: 10.2, 10.7, 13.2, 13.3_
  - [ ]* 6.4 Write property test for located-span substring correspondence
    - **Property 7: Every located highlight corresponds to an exact substring**
    - Generate an essay and a span set; assert each produced `HighlightRange` covers characters such that at least one contributing span equals `essayText.slice(start,end)` over its sub-extent, and each located span starts at the first (lowest-index) occurrence.
    - **Validates: Requirements 10.2, 10.3**
  - [ ]* 6.5 Write property test for the overlap union
    - **Property 8: Overlapping spans produce a single uniform union highlight**
    - Generate located span sets with overlaps; assert a character is in some `HighlightRange` iff covered by ≥1 span, and all highlighted runs share one uniform style (no distinct overlap styling in the segment model).
    - **Validates: Requirements 10.4**
  - [ ]* 6.6 Write property test for unlocated spans
    - **Property 9: Unlocated spans are skipped and flagged, never fabricated**
    - Generate spans guaranteed absent from the essay; assert no `HighlightRange` references that dimension and exactly one "not located" indication is recorded per unlocated dimension.
    - **Validates: Requirements 10.5**
  - [ ]* 6.7 Write property test for character preservation
    - **Property 10: Highlighting preserves the essay's characters**
    - Generate an essay and spans; assert concatenating the backdrop segments' text (markup removed, HTML-escaping reversed) equals the original essay exactly, including whitespace and line breaks.
    - **Validates: Requirements 10.2, 10.7**

- [x] 7. Implement the input gate and pipeline orchestration in `app.js`
  - [x] 7.1 Implement seam injection and the input gate
    - On module load (before the first evaluation) import the mock invoker and `setLlmCall` from both ported modules and inject the mock into both, so no stage hits the throwing stub.
    - Implement a pure `validateEssayInput(text)` returning the gate decision: reject empty/whitespace-only (invalid-essay message) and `> 20000` chars (over-length message) before any LLM call; valid otherwise.
    - Export `validateEssayInput` for property testing.
    - _Requirements: 5.3, 5.4, 6.2, 11.1_
  - [x] 7.2 Implement the pipeline orchestrator
    - On Evaluate: run the input gate; on valid input call `classifyShape(essayText)` → use empty `{}` modifiers (do **not** call `evaluateProfile`) → `evaluateEssay(essayText, {}, shape)` in that strict order; on classifier failure do not call `evaluateEssay`.
    - Return the single `Evaluation_Result` (and `Classification_Result`) to the render layer; never substitute a frontend-computed value for a module-returned one.
    - _Requirements: 6.1, 6.3, 6.4, 6.5, 6.6, 6.7, 2.1_
  - [x] 7.3 Implement the UI state machine and error-class mapping
    - Implement idle→running→(success|error): on running, show the in-progress indicator and disable the Evaluate action; on settle, remove the indicator and re-enable.
    - Map thrown errors by `.name`/`instanceof`: `EssayRequiredError`→invalid-essay; `ClassificationTimeoutError`/`EvaluationTimeoutError`→30s timeout message; `ClassificationFailedError`/`EvaluationFailedError`→evaluation-failed; `InvalidResponseError`→invalid-response; never render a fabricated/partial result on error.
    - Surface a "modules not loaded" message if an import is unavailable and a "LLM not configured" message if the active invoker is the throwing stub.
    - _Requirements: 2.3, 2.4, 6.7, 6.8, 11.2, 11.3, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_
  - [ ]* 7.4 Write property test for the empty/whitespace input gate
    - **Property 5: Empty or whitespace-only essay never invokes the LLM mock**
    - Generate empty/whitespace-only strings; with a spy invoker injected, assert neither `classifyShape` nor `evaluateEssay` invokes the mock and an input-validation message is shown.
    - **Validates: Requirements 5.3, 6.2**
  - [ ]* 7.5 Write property test for the over-length gate
    - **Property 6: Over-length essay never invokes `evaluateEssay`**
    - Generate strings strictly longer than 20000 chars; assert `evaluateEssay` never runs and the over-length message is shown.
    - **Validates: Requirements 5.4, 6.2**
  - [ ]* 7.6 Write integration tests for error mapping
    - With mocks that throw each error class, assert the correct UI message and no partial render for `ClassificationTimeoutError`, `EvaluationTimeoutError`, `ClassificationFailedError`, `EvaluationFailedError`, `InvalidResponseError`.
    - _Requirements: 6.7, 6.8, 12.2, 12.3, 12.4_

- [x] 8. Implement the DOM rendering in `app.js`
  - [x] 8.1 Render the band and the six score gauges
    - Render `Evaluation_Result.band` exactly as returned (no recomputation).
    - Render exactly six gauges in canonical order, each with label, numeric `score`, `reasoning`, a meter filled to `score/baseValue` (full when `score === baseValue`), and `role="meter"` + `aria-valuenow`/`aria-valuemin="0"`/`aria-valuemax="{baseValue}"` + `aria-label="{label}: {score} of {baseValue}"`.
    - Include a per-gauge "span not located" slot populated from the highlight computation.
    - _Requirements: 2.1, 7.1, 7.2, 7.3, 7.4, 7.5, 8.1, 8.2, 10.5, 13.1_
  - [x] 8.2 Render the UW feedback cards
    - Mechanics card: when `mechanics_pass` is false, list each `mechanics_errors` string; when true, show a pass indicator and no error entries.
    - Revisions card: exactly the three `revisions`, each with `original`, `suggested`, `reasoning`.
    - Claims card: each `claims` string; render none when `claims` is empty. Profile-flags card omitted this iteration.
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.6, 9.7_
  - [x] 8.3 Render highlights into the backdrop overlay and wire clear-on-edit
    - Render the backdrop as escaped text segments with `<mark class="hl">` for covered runs, each carrying the non-color indicator and `aria-label` naming its contributing dimension(s); sync backdrop scroll to the textarea.
    - On `input`, clear all `<mark>` runs and all span-not-located indications before the next evaluation.
    - _Requirements: 10.1, 10.2, 10.4, 10.6, 10.7, 13.2, 13.3_
  - [x] 8.4 Render the demo indicator, prompt-selection text, and status area
    - Show a persistent demo-mode indicator while the mock is the active invoker; display the selected prompt's full text on change without passing it to any module; render the status/error message area driven by the state machine.
    - _Requirements: 4.3, 4.4, 11.5, 12.1_
  - [ ]* 8.5 Write unit/integration tests for rendering
    - **Property 3: Rendered band equals `Evaluation_Result.band`** and **Property 4: Exactly six gauges are rendered** — generate `Evaluation_Result`s and assert the rendered band matches exactly and six gauges render with matching score/reasoning.
    - Example tests: mechanics pass/fail, three revisions, empty vs non-empty claims, no profile-flags card, clear-on-edit, gauge `role="meter"` and highlight `aria-label`.
    - **Validates: Requirements 2.1, 7.1, 7.3, 8.2, 9.2, 9.3, 9.4, 9.6, 9.7, 10.6, 13.1, 13.2, 13.3**

- [x] 9. Checkpoint — logic and rendering complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Build the HTML structure and wire the entry point
  - [x] 10.1 Create `index.html`
    - Split-screen container with a left region (prompt `<select>` of the seven Common App prompts, selected-prompt text display, essay-field with the `.essay-backdrop` + transparent-text `textarea.essay-input` structure, and the Evaluate button) and a right region (demo indicator, status area, band, six-gauge container, UW cards container).
    - Load `app.js` via `<script type="module">`; reference no build-step assets.
    - _Requirements: 1.1, 1.4, 3.1, 3.2, 3.3, 4.1, 4.2, 5.1, 7.1, 8.1, 9.1_

- [x] 11. Build the stylesheet
  - [x] 11.1 Create `styles.css`
    - Split-screen grid with a `@media` breakpoint that stacks the regions into one column so both remain reachable by scrolling.
    - Gauge meter styling, card styling, and the backdrop-overlay alignment (identical font/size/line-height/padding/border/width and `white-space: pre-wrap; word-break: break-word;` on both backdrop and textarea; transparent textarea text with visible `caret-color`; `<mark.hl>` yellow + underline non-color indicator).
    - Visible keyboard focus indicators for the prompt selector, essay input, and Evaluate action.
    - _Requirements: 3.1, 3.4, 5.1, 7.5, 10.1, 10.4, 10.7, 13.2, 13.4_

- [x] 12. Final checkpoint — full demo and tests
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (tests) and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references the specific requirement sub-clauses it satisfies for traceability.
- Property tests (Properties 1, 2, 5, 6, 7, 8, 9, 10, 11) target the deterministic/pure logic; Properties 3 and 4 are validated through the rendering tests in 8.5. Example and integration tests cover DOM, orchestration, error mapping, and the display-only prompt behavior.
- The ported `.js` modules are 1:1 conversions of the `.ts` sources (types stripped, runtime logic — pipelines, verbatim `SYSTEM_PROMPT`s, 30s timeout, seams, validation, retry loop, deterministic scoring, and named error classes — preserved exactly).
- All test assets load in the browser with no build step, consistent with Requirement 1.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1"] },
    { "id": 1, "tasks": ["2.2", "3.2"] },
    { "id": 2, "tasks": ["2.3", "3.3"] },
    { "id": 3, "tasks": ["3.4", "3.5", "3.6", "3.7", "4.1"] },
    { "id": 4, "tasks": ["4.2"] },
    { "id": 5, "tasks": ["4.3", "6.1", "6.2", "6.3"] },
    { "id": 6, "tasks": ["6.4", "6.5", "6.6", "6.7", "7.1"] },
    { "id": 7, "tasks": ["7.2", "7.3"] },
    { "id": 8, "tasks": ["7.4", "7.5", "7.6", "8.1", "8.2", "8.3", "8.4"] },
    { "id": 9, "tasks": ["8.5", "10.1"] },
    { "id": 10, "tasks": ["11.1"] }
  ]
}
```
