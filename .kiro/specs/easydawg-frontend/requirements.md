# Requirements Document

## Introduction

EasyDawg Frontend is a zero-build, vanilla HTML/CSS/JS web interface for the existing EasyDawg admissions-essay reviewer. It consists of exactly three static files — `index.html`, `styles.css`, and `app.js` — that run by being opened directly in a browser or served from a static file server. There is no Node.js runtime, no bundler, no transpiler, and no build step in the user's environment.

The frontend presents a split-screen workspace: the left side lets a reviewer select a Common App prompt and paste a student essay; the right side renders a feedback dashboard with one visual score gauge per backend scoring dimension, UW-specific feedback cards, and an overall band. When an essay is evaluated, the frontend applies yellow highlights to the exact verbatim text spans in the essay display that correspond to each dimension's score.

The frontend orchestrates the three existing logic modules at the workspace root — `router.ts` (`evaluateProfile`, pure/deterministic), `shape-classifier.ts` (`classifyShape`, LLM-backed), and `evaluator.ts` (`evaluateEssay`, LLM-backed) — through the pipeline: collect essay text (and optional student profile) → `classifyShape(essay)` → `evaluateProfile(profile)` for modifiers → `evaluateEssay(essay, modifiers, shape)` → render results and highlights.

Two module-contract facts shape these requirements and are treated as hard constraints:
1. The modules are TypeScript source using ES `import`/`export`. A browser cannot execute `.ts` files directly without a transpile/build step, which the environment forbids. A strategy to consume these contracts in the browser must be resolved in design.
2. The LLM seam (`setLlmCall`) in both `shape-classifier.ts` and `evaluator.ts` defaults to a stub that throws until a real implementation is injected. The frontend must configure an LLM invoker or provide a mock/demo path, and must surface the not-configured, failure, and timeout states to the reviewer.

## Open Assumptions (to confirm with the user)

- **A1 — Six gauges, not five.** The user asked for "5" gauges but listed six dimensions (Focus, Specificity, Character, How You Think, Contribution, Self-Awareness), which matches the backend's six dimensions exactly (`focus`, `specificity`, `character`, `how_you_think`, `contribution`, `self_awareness`). These requirements specify SIX gauges, one per backend dimension. The user's "5" is treated as a miscount. **Please confirm.**
- **A2 — Common App prompt is display/context only.** No existing module accepts a prompt selection; `evaluateEssay`, `classifyShape`, and `evaluateProfile` take no prompt parameter. The prompt dropdown is therefore treated as display/context only and does not alter evaluation inputs or outputs. **Please confirm, or specify how prompt choice should affect evaluation.**
- **A3 — Student profile entry is optional.** `evaluateProfile` requires a full `StudentProfile`. When the reviewer does not supply a profile, the frontend uses an empty modifier set (`{}`) and skips `evaluateProfile`. **Please confirm whether a profile input form is in scope for this iteration.**

## Glossary

- **Frontend**: The vanilla HTML/CSS/JS application composed of `index.html`, `styles.css`, and `app.js`.
- **App_Controller**: The orchestration logic in `app.js` that reads inputs, invokes the pipeline modules, and renders results.
- **Essay_Input**: The large text area on the left side where the reviewer pastes the student essay.
- **Essay_Display**: The visual rendering of the essay that supports highlighting (an overlay or contenteditable surface over or in place of the raw Essay_Input).
- **Prompt_Selector**: The dropdown on the left side listing Common App essay prompts.
- **Feedback_Dashboard**: The right-side panel containing the band, gauges, and feedback cards.
- **Score_Gauge**: A visual meter rendering one dimension's score against its base value.
- **Dimension**: One of the six backend scoring dimensions: `focus`, `specificity`, `character`, `how_you_think`, `contribution`, `self_awareness`.
- **Base_Value**: The pre-modifier maximum for a dimension: focus 25, specificity 25, character 20, how_you_think 20, contribution 15, self_awareness 10 (sum 115).
- **Band**: The integer 1–5 overall rating returned in `Evaluation_Result.band`.
- **UW_Feedback_Card**: A card in the Feedback_Dashboard surfacing mechanics errors, profile flags, revisions, or claims.
- **Span**: A verbatim, case-sensitive substring of the essay returned as `DimensionScore.span` for a dimension.
- **Highlight**: A yellow visual emphasis applied to a Span within the Essay_Display.
- **Pipeline**: The ordered sequence `classifyShape` → `evaluateProfile` (when a profile is present) → `evaluateEssay`.
- **Student_Profile**: The `StudentProfile` input to `evaluateProfile` (`router.ts`).
- **Evaluation_Result**: The object returned by `evaluateEssay` (`evaluator.ts`): `{ band, mechanics_pass, mechanics_errors, dimensions, revisions, claims }`.
- **Classification_Result**: The object returned by `classifyShape`: `{ shape, circularity, reasoning }`.
- **LLM_Invoker**: The implementation injected via `setLlmCall` in `shape-classifier.ts` and `evaluator.ts` that performs the model call.
- **LLM_Stub**: The default `setLlmCall` binding that throws until a real LLM_Invoker is injected.
- **Shape**: The narrative shape value `"linear"` or `"motif"` from `classifyShape`.

## Requirements

### Requirement 1: Zero-build static delivery

**User Story:** As a reviewer with no Node.js and no build tooling, I want the frontend to be three plain static files, so that I can run it by opening the files directly or serving them statically.

#### Acceptance Criteria

1. THE Frontend SHALL consist of exactly three files: `index.html`, `styles.css`, and `app.js`.
2. THE Frontend SHALL run when `index.html` is opened directly in a browser or served from a static file server, with no build, bundle, or transpile step.
3. THE Frontend SHALL NOT depend on a Node.js runtime, a package manager install, a bundler, or a transpiler at run time.
4. THE `app.js` file SHALL be loaded as a browser-native ES module (`<script type="module">`).
5. WHERE third-party libraries are used, THE Frontend SHALL load them as static assets without a package-manager install step.

### Requirement 2: Consuming the existing TypeScript module contracts in the browser

**User Story:** As a reviewer, I want the frontend wired directly to the existing `router.ts`, `shape-classifier.ts`, and `evaluator.ts` logic, so that the feedback I see comes from the real evaluation modules and not a reimplementation.

#### Acceptance Criteria

1. WHEN the Frontend renders evaluation output, THE Frontend SHALL source every rendered value from the return values of `evaluateProfile` (`router.ts`), `classifyShape` (`shape-classifier.ts`), and `evaluateEssay` (`evaluator.ts`) — the modifiers, flags, shape, band, dimension scores, revisions, and claims — and SHALL NOT substitute any value computed in the Frontend.
2. THE App_Controller SHALL treat `EvaluationResult` (`router.ts`: `modifiers` record and `flags` array), `ClassificationResult` (`shape-classifier.ts`: `shape`, `circularity`, `reasoning`), and `Evaluation_Result` (`evaluator.ts`: `band`, `mechanics_pass`, `mechanics_errors`, `dimensions`, `revisions`, `claims`) exactly as defined by those module type contracts.
3. IF a browser-consumable form of the module logic is not loaded when the reviewer first requests an evaluation, THEN THE Frontend SHALL display a visible message stating that the evaluation modules are not loaded, and SHALL NOT render any band, dimension score, modifier, or flag.
4. IF `classifyShape` or `evaluateEssay` rejects at run time (LLM seam not configured, timeout, request failed, or invalid response), or `evaluateProfile` throws, THEN THE Frontend SHALL display a visible error message and SHALL NOT render any fabricated band, dimension score, modifier, or flag.
5. WHEN `evaluateProfile` is called more than once with a Student_Profile whose fields are all equal, THE Frontend SHALL render identical modifiers (same keys and values) and identical flags (same strings in the same order) each time.

> Design must resolve how the TypeScript `import`/`export` module logic is made runnable in a browser without a transpiler (for example, providing hand-authored browser-ES-module equivalents of the pure logic, loading pre-compiled JS, or another no-build strategy). This requirement captures the behavior; the mechanism is a design decision.

### Requirement 3: Split-screen layout

**User Story:** As a reviewer, I want a split-screen workspace, so that I can read the essay and its feedback side by side.

#### Acceptance Criteria

1. THE Frontend SHALL present a split-screen layout with a left region and a right region visible at the same time.
2. THE Frontend SHALL place the Prompt_Selector and the Essay_Input in the left region.
3. THE Frontend SHALL place the Feedback_Dashboard in the right region.
4. WHILE the viewport is too narrow to show both regions side by side, THE Frontend SHALL stack the left and right regions so that both remain reachable by scrolling.

### Requirement 4: Common App prompt selector

**User Story:** As a reviewer, I want to select the Common App prompt the essay responds to, so that I have context while reading the feedback.

#### Acceptance Criteria

1. THE Prompt_Selector SHALL present the standard set of Common App essay prompts as selectable options.
2. THE Prompt_Selector SHALL allow exactly one prompt to be selected at a time.
3. WHEN the reviewer selects a prompt, THE Frontend SHALL display the selected prompt text in the left region.
4. THE Frontend SHALL treat the selected prompt as display/context only and SHALL NOT pass the prompt as an input to `classifyShape`, `evaluateProfile`, or `evaluateEssay` (see Open Assumption A2).

### Requirement 5: Essay input

**User Story:** As a reviewer, I want a large text area to paste the student's essay, so that I can submit it for evaluation.

#### Acceptance Criteria

1. THE Essay_Input SHALL accept and display pasted multi-line plain text.
2. WHEN the reviewer edits the Essay_Input, THE Frontend SHALL use the current Essay_Input text as the `essayText` argument for the Pipeline on the next evaluation.
3. IF the Essay_Input is empty or contains only whitespace when evaluation is requested, THEN THE Frontend SHALL display an invalid-essay message and SHALL NOT invoke `classifyShape` or `evaluateEssay`.
4. IF the Essay_Input text exceeds 20000 characters when evaluation is requested, THEN THE Frontend SHALL display a message stating the essay exceeds the 20000-character maximum and SHALL NOT invoke `evaluateEssay`.

### Requirement 6: Evaluation pipeline orchestration

**User Story:** As a reviewer, I want one action that runs the full evaluation pipeline, so that I get a complete assessment of the essay.

#### Acceptance Criteria

1. WHEN the reviewer requests an evaluation with an Essay_Input that contains at least one non-whitespace character and is at most 20,000 characters, THE App_Controller SHALL call `classifyShape` with the Essay_Input text to obtain the Shape.
2. IF the reviewer requests an evaluation with an Essay_Input that is empty, contains only whitespace, or exceeds 20,000 characters, THEN THE App_Controller SHALL NOT call `classifyShape`, `evaluateProfile`, or `evaluateEssay`, and SHALL present an input-validation message indicating that the essay is required and must be at most 20,000 characters.
3. WHERE a Student_Profile is provided, THE App_Controller SHALL call `evaluateProfile` with that Student_Profile to obtain the modifiers record.
4. WHERE no Student_Profile is provided, THE App_Controller SHALL use an empty modifiers record (`{}`) and SHALL NOT call `evaluateProfile`.
5. WHEN the Shape and modifiers are available, THE App_Controller SHALL call `evaluateEssay` with the Essay_Input text, the modifiers record, and the Shape, in that pipeline order (`classifyShape` before any `evaluateProfile` call, and both before `evaluateEssay`).
6. WHEN `evaluateEssay` returns an Evaluation_Result, THE App_Controller SHALL render the Band, the six Score_Gauges, the UW_Feedback_Cards, and the Highlights from that single Evaluation_Result.
7. IF `classifyShape` fails to produce a Shape (request failure, timeout, or invalid response), THEN THE App_Controller SHALL NOT call `evaluateProfile` or `evaluateEssay`, SHALL NOT render any Band, Score_Gauges, UW_Feedback_Cards, or Highlights, and SHALL present an error message indicating that the evaluation could not be completed.
8. IF `evaluateEssay` fails to return an Evaluation_Result (request failure, timeout, or invalid response), THEN THE App_Controller SHALL NOT render any Band, Score_Gauges, UW_Feedback_Cards, or Highlights, and SHALL present an error message indicating that the evaluation could not be completed.

### Requirement 7: Dimension score gauges

**User Story:** As a reviewer, I want a visual gauge for each scoring dimension, so that I can quickly read the essay's strengths and weaknesses.

#### Acceptance Criteria

1. THE Feedback_Dashboard SHALL render exactly six Score_Gauges, one for each Dimension in `Evaluation_Result.dimensions` (see Open Assumption A1).
2. THE Frontend SHALL render each Score_Gauge against that Dimension's Base_Value (focus 25, specificity 25, character 20, how_you_think 20, contribution 15, self_awareness 10).
3. THE Frontend SHALL display, for each Score_Gauge, the Dimension's `score` and its `reasoning` text from `Evaluation_Result.dimensions`.
4. THE Frontend SHALL label each Score_Gauge with a human-readable name for its Dimension.
5. WHEN a Dimension `score` equals its Base_Value, THE Frontend SHALL render that Score_Gauge as full.

### Requirement 8: Overall band display

**User Story:** As a reviewer, I want to see the overall band, so that I understand the essay's summary rating.

#### Acceptance Criteria

1. THE Feedback_Dashboard SHALL display the `band` value from `Evaluation_Result` as an integer between 1 and 5 inclusive.
2. THE Frontend SHALL display the Band using the exact value returned in `Evaluation_Result.band` and SHALL NOT recompute the Band in the Frontend.

### Requirement 9: UW feedback cards

**User Story:** As a reviewer, I want feedback cards below the gauges, so that I can see mechanics issues, profile flags, suggested revisions, and claims in one place.

#### Acceptance Criteria

1. THE Frontend SHALL render the UW_Feedback_Cards below the Score_Gauges in the Feedback_Dashboard.
2. WHEN `Evaluation_Result.mechanics_pass` is false, THE Frontend SHALL display each string in `Evaluation_Result.mechanics_errors` in a mechanics UW_Feedback_Card.
3. WHEN `Evaluation_Result.mechanics_pass` is true, THE Frontend SHALL display a mechanics-pass indication and SHALL display no mechanics-error entries.
4. THE Frontend SHALL display exactly the three revisions in `Evaluation_Result.revisions`, each showing its `original`, `suggested`, and `reasoning`.
5. WHERE a Student_Profile produced flags via `evaluateProfile`, THE Frontend SHALL display each string in the profile `flags` array in a UW_Feedback_Card.
6. THE Frontend SHALL display each Claim_Id string in `Evaluation_Result.claims` in the Feedback_Dashboard.
7. WHEN `Evaluation_Result.claims` is an empty array, THE Frontend SHALL display no claim entries.

### Requirement 10: Verbatim span highlighting

**User Story:** As a reviewer, I want the exact essay text behind each dimension score highlighted, so that I can see which passages drove the feedback.

#### Acceptance Criteria

1. WHEN an Evaluation_Result is rendered, THE Frontend SHALL apply a yellow Highlight to the Essay_Display text matching each Dimension's `span`.
2. THE Frontend SHALL match each `span` as the exact, case-sensitive, character-for-character substring returned in `Evaluation_Result.dimensions`, preserving the original whitespace, punctuation, and line breaks of the `span`.
3. WHEN a Dimension's `span` occurs more than once in the Essay_Display text, THE Frontend SHALL apply the Highlight to the first occurrence, counting from the start of the Essay_Display text.
4. WHERE two or more Dimension `span` values overlap in the Essay_Display text or resolve to the same text range, THE Frontend SHALL apply the yellow Highlight to every character covered by at least one matched `span`, and SHALL render the overlapping region with the same yellow Highlight as non-overlapping Highlighted regions.
5. IF a Dimension `span` is not found as a substring of the current Essay_Display text, THEN THE Frontend SHALL skip the Highlight for that Dimension and SHALL display a visible indication, associated with that Dimension, that its span could not be located.
6. WHEN the reviewer edits the Essay_Input after an evaluation, THE Frontend SHALL clear all existing Highlights and all span-not-located indications before the next evaluation is rendered.
7. THE Frontend SHALL preserve the essay's original characters, whitespace, and line breaks in the Essay_Display when Highlights are applied.

> Highlighting an editable `<textarea>` is not directly possible. Design must choose an approach (for example, an overlay layer aligned to the textarea, or a `contenteditable` Essay_Display). This requirement captures the behavior; the mechanism is a design decision.

### Requirement 11: LLM seam configuration and demo path

**User Story:** As a reviewer, I want the LLM-backed evaluation to actually run, so that the UI produces feedback instead of failing on the default stub.

#### Acceptance Criteria

1. WHEN the reviewer initiates an evaluation, THE Frontend SHALL inject an LLM_Invoker into both `shape-classifier.ts` and `evaluator.ts` via `setLlmCall` before any Pipeline stage runs, such that no Pipeline stage executes against the default not-configured stub.
2. IF the active LLM_Invoker is the default stub (reporting that the Kiro LLM SDK binding is not configured), THEN THE Frontend SHALL display a message indicating that the LLM is not configured, SHALL NOT display any scores or evaluation results, and SHALL leave any previously entered essay input unchanged.
3. IF the injected LLM_Invoker returns a response that the module rejects as invalid (InvalidResponseError), THEN THE Frontend SHALL display a message indicating that the evaluation response was invalid and SHALL NOT display any fabricated or partial scores.
4. WHERE the demo mode is selected, THE Frontend SHALL inject a demo LLM_Invoker that returns JSON matching each module's schema so that the Pipeline completes without raising InvalidResponseError and the UI renders feedback without a live model binding.
5. WHILE the demo LLM_Invoker is the active invoker, THE Frontend SHALL display a persistent, visible demo indicator stating that demo responses are in use.

### Requirement 12: Loading, error, and timeout states

**User Story:** As a reviewer, I want clear status while an evaluation runs and when it fails, so that I know whether to wait, retry, or fix my input.

#### Acceptance Criteria

1. WHILE the Pipeline is running, THE Frontend SHALL display an in-progress indicator and SHALL disable the evaluation action.
2. IF `classifyShape` or `evaluateEssay` rejects with a timeout error (`ClassificationTimeoutError` or `EvaluationTimeoutError`), THEN THE Frontend SHALL display a timeout message stating the model did not respond within 30 seconds.
3. IF `classifyShape` rejects with `ClassificationFailedError`, or `evaluateEssay` rejects with `EvaluationFailedError`, THEN THE Frontend SHALL display an evaluation-failed message.
4. IF `classifyShape` or `evaluateEssay` rejects with `InvalidResponseError`, THEN THE Frontend SHALL display a message stating the model returned an invalid response.
5. IF `classifyShape` or `evaluateEssay` rejects with `EssayRequiredError`, THEN THE Frontend SHALL display the invalid-essay message.
6. WHEN the Pipeline settles (success or failure), THE Frontend SHALL remove the in-progress indicator and re-enable the evaluation action.

### Requirement 13: Accessibility for gauges and highlights

**User Story:** As a reviewer using assistive technology, I want the gauges and highlights to be perceivable, so that I can use the feedback without relying on color alone.

#### Acceptance Criteria

1. THE Frontend SHALL expose each Score_Gauge's Dimension name, `score`, and Base_Value as a programmatically determinable text alternative.
2. THE Frontend SHALL convey each Highlight with a non-color indicator in addition to the yellow color.
3. THE Frontend SHALL associate each Highlight with its Dimension so that the relationship is programmatically determinable.
4. THE Frontend SHALL provide a visible keyboard focus indicator for the Prompt_Selector, the Essay_Input, and the evaluation action.
