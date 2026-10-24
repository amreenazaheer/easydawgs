# Implementation Plan: shape-classifier

## Overview

Implement the `shape-classifier` feature as a single new TypeScript file, `shape-classifier.ts`, in the EasyDawg project root alongside `router.ts`, plus a companion test file using `fast-check` for property-based tests. The work proceeds bottom-up: first the public types and fixed prompt, then the pure deterministic stages (input validation, JSON parsing, strict result validation), then the mockable LLM seam with a 30-second timeout, and finally the `classifyShape` orchestrator that wires every stage together. Tests (property, example, and mock-based integration) are layered in close to the code they exercise so errors surface early. Each step follows the conventions in `router.ts`: exported interfaces, JSDoc on exported functions, named exports, and explicit typing.

## Tasks

- [x] 1. Establish module types, constants, and error model
  - [x] 1.1 Create `shape-classifier.ts` with the public types and LLM seam scaffold
    - Create `shape-classifier.ts` in the project root (alongside `router.ts`)
    - Export the `ShapeValue` type (`"linear" | "motif"`) and the `ClassificationResult` interface with `shape: ShapeValue`, `circularity: boolean`, and `reasoning: string`, each with a JSDoc member comment
    - Declare the `LLM_TIMEOUT_MS = 30_000` constant
    - Define the internal LLM seam type (e.g. `LlmInvoker` / `invokeLlm`) as a narrow, mockable function so later tests can substitute a mock
    - Define the named error types `EssayRequiredError`, `ClassificationFailedError`, `ClassificationTimeoutError`, and `InvalidResponseError` as `Error` subclasses with distinct names/messages
    - _Requirements: 1.5, 1.6, 1.7, 3.1, 4.1_

  - [x] 1.2 Author the `SYSTEM_PROMPT` constant encoding the Requirement 2 rules
    - Add the fixed `SYSTEM_PROMPT` string constant to `shape-classifier.ts`
    - Encode: linear rule (unconnected episodes / chronological timeline, no recurring anchor), motif rule (returns ≥2 times to a specific object/metaphor/image), both-match → "motif" tie-break, neither-match → "linear" default
    - Encode circularity true/false conditions (ending explicitly returns to the exact opening image/scene/question → true, otherwise false)
    - Encode the reasoning instruction: exactly one sentence, ≤ 200 characters, naming the specific textual evidence
    - State the exact JSON output schema `{ "shape": "linear" | "motif", "circularity": <boolean>, "reasoning": "<string>" }` and that `circularity` must be a JSON boolean, never a number or string
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [ ]* 1.3 Write example tests asserting `SYSTEM_PROMPT` content
    - Create the test file (e.g. `shape-classifier.test.ts`) and assert `SYSTEM_PROMPT` contains wording for: the linear rule, the motif rule, both-match → motif tie-break, neither-match → linear default, circularity true/false conditions, and the one-sentence/≤200-char/textual-evidence reasoning instruction
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

- [x] 2. Implement and test input validation
  - [x] 2.1 Implement `assertNonEmptyEssay`
    - Add an internal `assertNonEmptyEssay(essayText: string): void` that throws `EssayRequiredError` when the trimmed text is empty (empty string or whitespace-only)
    - _Requirements: 1.2_

  - [ ]* 2.2 Write property test for input validation
    - **Property 1: Empty or whitespace-only input is always rejected before any LLM call**
    - **Validates: Requirements 1.2**
    - Use `fast-check` with `numRuns >= 100`; generate whitespace-only strings (including the empty string, spaces, tabs, newlines); assert `classifyShape` rejects with `EssayRequiredError` and the mocked LLM seam was never called
    - Tag: `// Feature: shape-classifier, Property 1: ...`
    - _Requirements: 1.2_

- [x] 3. Implement and test response parsing
  - [x] 3.1 Implement `parseResponse`
    - Add an internal `parseResponse(raw: string): unknown` that `JSON.parse`s the raw LLM text and wraps any syntax error in an `InvalidResponseError` that identifies the JSON syntax fault
    - _Requirements: 3.3_

- [x] 4. Implement and test strict result validation
  - [x] 4.1 Implement `validateResult`
    - Add an internal `validateResult(value: unknown): ClassificationResult` enforcing, in order: value is a non-null object; `shape` is exactly `"linear"` or `"motif"`; `circularity` is strictly of type `boolean` (reject `0`, `1`, `"true"`, `"false"`, `null`, objects); `reasoning` is a non-empty string ≤ 2000 chars
    - Throw `InvalidResponseError` naming the specific missing field, invalid `shape` value, invalid `circularity` value and its type, or invalid `reasoning` value
    - _Requirements: 1.4, 1.7, 1.8, 3.2, 3.4, 3.5_

  - [ ]* 4.2 Write property test for valid-output round-trip
    - **Property 2: Valid LLM output round-trips to a conforming ClassificationResult**
    - **Validates: Requirements 1.4, 1.5, 1.6, 1.7, 3.2**
    - Use `fast-check` with `numRuns >= 100`; generate valid `ClassificationResult` values (`shape` from the two literals, `circularity` an arbitrary boolean, `reasoning` a non-empty string ≤ 2000 chars), `JSON.stringify` as the mocked LLM output, and assert the returned object deep-equals the generated value
    - Tag: `// Feature: shape-classifier, Property 2: ...`
    - _Requirements: 1.4, 1.5, 1.6, 1.7, 3.2_

  - [ ]* 4.3 Write property test for malformed/invalid-response rejection
    - **Property 3: Any malformed or invalid LLM response is rejected with no result**
    - **Validates: Requirements 1.8, 3.3, 3.4, 3.5**
    - Use `fast-check` with `numRuns >= 100`; generate invalid responses (malformed JSON; non-object JSON; objects missing one field; `shape` outside the two literals; `circularity` non-boolean including `0`/`1`/`"true"`/`null`; `reasoning` non-string or empty); assert `classifyShape` rejects with `InvalidResponseError` and returns no result
    - Tag: `// Feature: shape-classifier, Property 3: ...`
    - _Requirements: 1.8, 3.3, 3.4, 3.5_

- [x] 5. Checkpoint - deterministic layers
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement the LLM seam and prompt assembly
  - [x] 6.1 Implement `buildMessages` and `invokeLlm`
    - Add `buildMessages(essayText: string)` to assemble the request payload from `SYSTEM_PROMPT` + `essayText`
    - Implement the default `invokeLlm(req, timeoutMs)` using Kiro's LLM capability, enforcing the 30s timeout in code via `Promise.race` against a timer (or an `AbortSignal`); surface transport failure as `ClassificationFailedError` and timeout as `ClassificationTimeoutError`
    - _Requirements: 1.3, 1.9_

- [x] 7. Implement and wire the public `classifyShape` function
  - [x] 7.1 Implement `classifyShape` orchestrating all stages
    - Add the named exported async `classifyShape(essayText: string): Promise<ClassificationResult>` with a JSDoc block documenting the `essayText` parameter and the returned `ClassificationResult`
    - Pipeline: `assertNonEmptyEssay` → `buildMessages` → `invokeLlm` (30s) → `parseResponse` → `validateResult` → return
    - Allow the LLM seam to be injected/overridable for testing while keeping `invokeLlm` as the default
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.8, 1.9, 4.2, 4.3_

  - [ ]* 7.2 Write signature, export, and JSDoc smoke tests
    - Assert `classifyShape` is a named, exported async function accepting a string; assert `ClassificationResult` is exported with the three declared members (compile-time type assertion); check the JSDoc block documents `essayText` and the result
    - _Requirements: 1.1, 3.1, 4.1, 4.2, 4.3_

  - [ ]* 7.3 Write mock-based integration tests for the LLM interaction
    - Request assembly: with a mocked seam, call `classifyShape` with a representative non-empty essay and assert the seam was called once with a payload containing both `SYSTEM_PROMPT` and `essayText`, with a 30s timeout configured
    - Transport failure: mock the seam to reject; assert rejection with `ClassificationFailedError`
    - Timeout: mock the seam to never resolve within the window (fake timers); assert rejection with `ClassificationTimeoutError` after 30 seconds
    - _Requirements: 1.3, 1.9_

- [x] 8. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP; they cover the property, example, and integration tests from the design's Testing Strategy.
- Each task references specific requirements for traceability.
- Checkpoints ensure incremental validation of the deterministic layers and the full wired module.
- Property tests use `fast-check` (not hand-rolled), run a minimum of 100 iterations, and are tagged with their design property number per the Testing Strategy.
- The LLM seam is mocked in all unit, property, and integration tests so the deterministic pipeline runs without network calls or model variability.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "3.1", "4.1"] },
    { "id": 2, "tasks": ["1.3", "2.2", "4.2", "4.3", "6.1"] },
    { "id": 3, "tasks": ["7.1"] },
    { "id": 4, "tasks": ["7.2", "7.3"] }
  ]
}
```
