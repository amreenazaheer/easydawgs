# Implementation Plan: Essay Evaluator

## Overview

Build `evaluator.ts` as a single new module at the workspace root (sibling of `shape-classifier.ts`), mirroring that module's architecture: exported types, a fixed `SYSTEM_PROMPT`, an injectable LLM seam with an in-code timeout wrapper, strict deterministic parse/validate stages separated from the LLM call, named error classes, and an async `evaluateEssay` orchestrator.

The module is built bottom-up: scaffolding (types, constants, errors) first, then the system prompt, then the LLM seam, then the deterministic pipeline stages (input guard, message assembly, parse, strict schema validation, span/revision validation, scoring, modifier application, total/band derivation), then the `evaluateEssay` orchestrator that wires the retry loop and assembles the final result. Each stage is validated with unit tests, and the 16 design correctness properties are implemented as fast-check property tests (minimum 100 iterations each) placed close to the code they exercise.

Because the project has no `package.json` / `node_modules` yet, the first task establishes the TypeScript test tooling (a test runner plus `fast-check`) required to run the property-based tests.

## Tasks

- [x] 1. Set up TypeScript test tooling and module scaffolding
  - Initialize `package.json` at the workspace root and add dev dependencies: TypeScript, a test runner (Vitest), and `fast-check` for property-based tests
  - Add a `tsconfig.json` and a test script that runs in single-execution (non-watch) mode
  - Create `evaluator.ts` at the workspace root (sibling of `shape-classifier.ts`) with the module header comment and the public type/interface surface: `ShapeValue` (`"linear" | "motif"`), the internal `DimensionKey` union, `DimensionScore`, `Revision`, `DimensionScores`, `Evaluation_Result`, the internal `LlmEvaluation` type (no `band`), `LlmRequest`, and `LlmInvoker`
  - Add the constants `LLM_TIMEOUT_MS = 30_000`, `MAX_ESSAY_LENGTH = 20_000`, `DIMENSION_KEYS` (canonical six-key order), and `BASE_VALUES` (focus 25, specificity 25, character 20, how_you_think 20, contribution 15, self_awareness 10)
  - Declare the four named error classes `EssayRequiredError`, `EvaluationFailedError`, `EvaluationTimeoutError`, and `InvalidResponseError`, each extending `Error` and setting `name`
  - _Requirements: 1.1, 1.5, 1.6, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 10.3_

  - [ ]* 1.1 Write unit tests for scaffolding constants and error classes
    - Assert `BASE_VALUES` equals the specified per-dimension mapping and sums to 115
    - Assert `DIMENSION_KEYS` contains exactly the six keys in canonical order
    - Assert each error class sets its `name` and extends `Error`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 14.1_

- [x] 2. Implement the SYSTEM_PROMPT constant
  - Add the exported `SYSTEM_PROMPT` encoding all scoring rules: the six dimensions and their base values; both the linear Focus anchor set and the motif Focus anchor set with the rule that selects anchors by the `SHAPE` marker; the mechanics pass/fail rules; the exactly-three sentence-level revision rule (each `original` a verbatim essay substring); the verbatim-span rule for each dimension; the claims-as-opaque-strings rule; and the exact JSON output schema that **excludes** `band` (dimensions, mechanics_pass, mechanics_errors, revisions, claims only)
  - _Requirements: 5.1, 5.2, 5.3, 6.1, 7.1, 7.3, 8.1, 9.1, 10.4, 13.5_

- [x] 3. Implement the LLM seam and timeout wrapper
  - [x] 3.1 Implement the injectable seam
    - Add the module-level `llmCall` default stub `(req, signal) => Promise<string>` that throws the "Kiro LLM SDK binding is not configured" error, and the exported `setLlmCall` that replaces it
    - _Requirements: 10.1, 10.2, 10.3_

  - [x] 3.2 Implement `invokeLlm` timeout wrapper
    - Build an `AbortController`, race `llmCall` against a timer via `Promise.race`, abort the in-flight call on timeout, map the timer win to `EvaluationTimeoutError`, and map any other underlying rejection to `EvaluationFailedError`; clear the timer in `finally`
    - _Requirements: 11.1, 11.2, 11.3, 12.1_

  - [ ]* 3.3 Write unit tests for the seam and timeout/failure mapping
    - Assert the default stub throws the not-configured message, `setLlmCall` replaces the seam, and every call routes through the seam
    - Using fake timers and a never-resolving mock, assert `EvaluationTimeoutError` is thrown and the signal is aborted; using a rejecting mock, assert `EvaluationFailedError` is thrown
    - _Requirements: 10.1, 10.2, 10.3, 11.1, 11.2, 11.3, 12.1_

- [x] 4. Implement input guard and message assembly
  - [x] 4.1 Implement `assertNonEmptyEssay` and `buildMessages`
    - `assertNonEmptyEssay` throws `EssayRequiredError` when the essay is empty or whitespace-only, before any LLM request; `buildMessages(essayText, shape)` returns an `LlmRequest` with `systemPrompt === SYSTEM_PROMPT` and user text carrying an explicit `SHAPE` marker reflecting the supplied shape, with the essay body delimited so span validation checks against the original essay
    - _Requirements: 2.1, 5.1, 5.2, 5.3, 10.4_

  - [ ]* 4.2 Write property test for empty/whitespace rejection
    - **Property 2: Empty or whitespace essays are rejected before any LLM call**
    - **Validates: Requirements 2.1**

  - [ ]* 4.3 Write property test for the assembled request
    - **Property 5: The assembled request carries the system prompt and the supplied shape**
    - **Validates: Requirements 5.1, 5.2, 5.3, 10.4**

- [x] 5. Implement response parsing and strict schema validation
  - [x] 5.1 Implement `parseResponse`
    - Parse the raw LLM text with `JSON.parse`; on a syntax fault, throw `InvalidResponseError` whose message identifies the JSON syntax fault
    - _Requirements: 13.1, 13.2_

  - [ ]* 5.2 Write property test for malformed JSON
    - **Property 10: Malformed JSON is rejected with a syntax-identifying error**
    - **Validates: Requirements 13.2**

  - [x] 5.3 Implement `validateLlmEvaluation` (strict, no coercion)
    - Narrow parsed `unknown` to `LlmEvaluation`: each of the six dimension entries present with finite `score >= 0`, non-empty `span` string, non-empty `reasoning` string; `mechanics_pass` strictly boolean; `mechanics_errors` an array of strings; `revisions` an array of `{original, suggested, reasoning}` string objects; `claims` an array of strings; mechanics consistency (empty errors when pass is true, at least one when false); never read or parse `band`; checks run in order and name the first missing/wrong-typed field and its value; no coercion or defaulting
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 9.1, 13.1, 13.3, 13.4, 13.5, 13.6_

  - [ ]* 5.4 Write property test for strict schema rejection
    - **Property 11: Strict schema validation rejects missing or wrong-typed fields without coercion**
    - **Validates: Requirements 8.1, 8.2, 9.1, 13.1, 13.3, 13.4, 13.6**

  - [ ]* 5.5 Write property test for mechanics consistency
    - **Property 12: Mechanics pass/fail is consistent with the error list**
    - **Validates: Requirements 8.3, 8.4**

- [x] 6. Implement deterministic span and revision validation
  - [x] 6.1 Implement `validateSpansAndRevisions`
    - For each of the six dimensions, require `span` to be a non-empty, exact case-sensitive substring of `essayText`; require exactly three revisions, each `original` an exact substring of `essayText`; return a discriminated outcome naming the offending dimension/revision and its value so the retry loop can decide to retry or throw
    - _Requirements: 6.1, 6.2, 6.5, 7.1, 7.2, 7.3, 7.6, 7.7_

  - [ ]* 6.2 Write property test for verbatim dimension spans
    - **Property 6: Every dimension span is a non-empty verbatim substring of the essay**
    - **Validates: Requirements 6.1, 6.2, 6.5**

  - [ ]* 6.3 Write property test for exactly-three verbatim revisions
    - **Property 7: Revisions are exactly three with verbatim originals**
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.6, 7.7**

- [x] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement deterministic scoring, modifiers, total, and band
  - [x] 8.1 Implement `scoreDimensions` and `applyProfileModifiers`
    - `scoreDimensions` derives the base-value dimension scores from the validated `LlmEvaluation`; `applyProfileModifiers` matches each modifier key case-insensitively against `DIMENSION_KEYS`, adds the finite value to the matched dimension's score, clamps the result to `[0, BASE_VALUES[key]]`, and leaves all scores unchanged for non-matching keys (including an empty map)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [ ]* 8.2 Write property test for additive, clamped modifiers
    - **Property 3: Profile modifiers are additive and clamped to each dimension's base value**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.2, 4.3**

  - [ ]* 8.3 Write property test for non-matching modifier keys
    - **Property 4: Non-matching modifier keys leave all scores unchanged**
    - **Validates: Requirements 4.4, 4.5**

  - [x] 8.4 Implement `computeTotalScore` and `deriveBand`
    - `computeTotalScore` sums the six finalized scores (0–115); `deriveBand` maps the total onto band 1–5 via five equal 23-point bands (0–23→1, 24–46→2, 47–69→3, 70–92→4, 93–115→5) as a pure function of the total with no LLM involvement
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8_

  - [ ]* 8.5 Write property test for total score
    - **Property 14: Total score is the sum of the six finalized scores within 0–115**
    - **Validates: Requirements 14.1**

  - [ ]* 8.6 Write property test for band derivation
    - **Property 15: Band is derived deterministically via equal 23-point bands**
    - **Validates: Requirements 1.4, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8**

- [x] 9. Implement the evaluateEssay orchestrator and wire the pipeline
  - [x] 9.1 Implement `evaluateEssay` with the retry loop
    - Wire the pipeline: `assertNonEmptyEssay` → `buildMessages` → retry loop (3 total attempts) of `invoker(req, LLM_TIMEOUT_MS)` → `parseResponse` → `validateLlmEvaluation` → `validateSpansAndRevisions`; retry only on span/revision faults, surface JSON/schema faults immediately, and on retry exhaustion throw `InvalidResponseError` naming the fault and return nothing; on acceptance run `scoreDimensions` → `applyProfileModifiers` → `computeTotalScore` → `deriveBand` and assemble the `Evaluation_Result` with the computed `band`; default the `invoker` parameter to `invokeLlm`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 4.1, 6.3, 6.4, 7.4, 7.5, 13.5, 14.1, 14.8_

  - [ ]* 9.2 Write property test for the overall result shape
    - **Property 1: Result shape is exactly the six fields with valid dimensions**
    - **Validates: Requirements 1.1, 1.5, 1.6**

  - [ ]* 9.3 Write property test for retry-then-succeed behavior
    - **Property 8: The evaluator retries on span/revision faults and succeeds within three attempts**
    - **Validates: Requirements 6.3, 7.4**

  - [ ]* 9.4 Write property test for exhausted retries
    - **Property 9: Exhausted retries throw InvalidResponseError and return nothing**
    - **Validates: Requirements 6.4, 7.5**

  - [ ]* 9.5 Write property test for claims pass-through
    - **Property 13: Claim identifiers pass through unchanged as opaque strings**
    - **Validates: Requirements 9.2, 9.3**

  - [ ]* 9.6 Write property test for band ignoring any LLM-provided band
    - **Property 16: The returned band ignores any band present in the LLM response**
    - **Validates: Requirements 13.5, 14.8**

- [x] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation sub-tasks are never optional.
- Each task references specific requirement sub-clauses for traceability; property-test sub-tasks map one-to-one to the 16 correctness properties in the design.
- Property-based tests use `fast-check`, run a minimum of 100 iterations each, and are tagged with a comment in the format `Feature: essay-evaluator, Property {number}: {property_text}`.
- Checkpoints ensure incremental validation after the deterministic validation stages and after full wiring.
- The LLM seam stays a default stub behind `setLlmCall`; all tests inject a mock `invoker` so the deterministic pipeline is exercised without a live model.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["1.1", "2", "3.1", "4.1", "5.1", "6.1", "8.1", "8.4"] },
    { "id": 2, "tasks": ["3.2", "4.2", "4.3", "5.2", "5.3", "6.2", "6.3", "8.2", "8.3", "8.5", "8.6"] },
    { "id": 3, "tasks": ["3.3", "5.4", "5.5", "9.1"] },
    { "id": 4, "tasks": ["9.2", "9.3", "9.4", "9.5", "9.6"] }
  ]
}
```
