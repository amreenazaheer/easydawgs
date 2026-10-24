# Requirements Document

## Introduction

The Essay Evaluator is the core LLM-backed scoring module for the EasyDawg admissions reviewer. It reads a student's application essay and produces a structured, deterministic evaluation: an overall band, a mechanics pass/fail with enumerated errors, a per-dimension score breakdown (each anchored to a verbatim quote from the essay), exactly three sentence-level rewrite suggestions, and the set of UW resource-hub claim identifiers that apply to the feedback.

The module is the third stage of the EasyDawg pipeline and consumes the outputs of the two existing upstream modules. `router.ts` exports `evaluateProfile`, whose `modifiers` field (keys such as `"Character"` and `"Contribution"`) is the source of the `profileModifiers` argument. `shape-classifier.ts` exports `classifyShape`, whose `shape` field (`"linear"` or `"motif"`) is the source of the `shape` argument used to select the Focus-dimension anchors.

The Essay Evaluator follows the same established architectural pattern as `shape-classifier.ts`: an injectable LLM seam (`setLlmCall` / `LlmInvoker`), a fixed `SYSTEM_PROMPT` constant that encodes all scoring rules, an in-code timeout wrapper governed by `LLM_TIMEOUT_MS`, strict deterministic parse and validate stages kept separate from the LLM call, and named error classes. The verbatim-span requirement and the exactly-three-revisions requirement are enforced as deterministic validations that reject and retry the LLM, not left to the model's discretion. Because the project has no confirmed Kiro LLM SDK binding (no `package.json` / `node_modules`), the concrete model call is a stub behind the injectable seam, exactly as in `shape-classifier.ts`.

## Glossary

- **Essay_Evaluator**: THE system described by this document; the module exported from `evaluator.ts` whose public entry point is the async `evaluateEssay` function.
- **Essay_Text**: The raw student application essay text supplied to `evaluateEssay` as the first argument.
- **Profile_Modifiers**: The `Record<string, number>` supplied to `evaluateEssay` as the second argument, sourced from the `modifiers` field of `router.ts`'s `evaluateProfile`; keys name dimensions (for example `"Character"`, `"Contribution"`) and values are numeric weight adjustments.
- **Shape**: The narrative-shape classification supplied to `evaluateEssay` as the third argument, one of the string literals `"linear"` or `"motif"`, sourced from the `shape` field of `shape-classifier.ts`'s `classifyShape`.
- **Dimension**: One of the six scored rubric categories: Focus, Specificity, Character, How_You_Think, Contribution, and Self_Awareness.
- **Base_Value**: The maximum point value assigned to a Dimension before Profile_Modifiers are applied: Focus 25, Specificity 25, Character 20, How_You_Think 20, Contribution 15, Self_Awareness 10.
- **Band**: An overall integer rating from 1 to 5 inclusive produced for the essay.
- **Total_Score**: The sum of the six finalized Dimension scores after Profile_Modifiers have been applied, ranging from 0 to a maximum of 115 (25 + 25 + 20 + 20 + 15 + 10).
- **Mechanics_Check**: The pass/fail assessment of the essay's grammar, spelling, and punctuation, reported as `mechanics_pass` with an accompanying `mechanics_errors` list.
- **Span**: An exact, verbatim substring copied from the Essay_Text that justifies a Dimension's score.
- **Revision**: A single sentence-level rewrite consisting of an `original` sentence from the essay, a `suggested` rewrite of that same sentence, and a `reasoning` string.
- **Claim_Id**: An identifier of a UW resource-hub claim that applies to the feedback, returned in the `claims` list.
- **LLM_Seam**: The injectable module-level LLM call boundary, overridable via `setLlmCall`, matching the pattern in `shape-classifier.ts`.
- **LLM_Timeout**: The maximum time, defined by the `LLM_TIMEOUT_MS` constant, that Essay_Evaluator waits for an LLM response.
- **Evaluation_Result**: The JSON object returned by `evaluateEssay` containing `band`, `mechanics_pass`, `mechanics_errors`, `dimensions`, `revisions`, and `claims`.

## Requirements

### Requirement 1: Evaluate an essay and return the structured result

**User Story:** As an EasyDawg admissions reviewer, I want to submit an essay and receive a structured evaluation, so that I can assess the application against the rubric consistently.

#### Acceptance Criteria

1. WHEN `evaluateEssay` is called with an Essay_Text that contains at least one non-whitespace character and is at most 20,000 characters long, a Profile_Modifiers object, and a Shape value, THE Essay_Evaluator SHALL return an Evaluation_Result object containing exactly the fields `band`, `mechanics_pass`, `mechanics_errors`, `dimensions`, `revisions`, and `claims`.
2. THE Essay_Evaluator SHALL accept the Shape argument as exactly one of the string literals `"linear"` or `"motif"`.
3. THE Essay_Evaluator SHALL accept the Profile_Modifiers argument as a `Record<string, number>` whose keys name dimensions and whose values are finite numeric weight adjustments.
4. WHEN the Essay_Evaluator returns an Evaluation_Result, THE Essay_Evaluator SHALL set `band` to an integer in the range 1 to 5 inclusive.
5. WHEN the Essay_Evaluator returns an Evaluation_Result, THE Essay_Evaluator SHALL include in `dimensions` exactly the six keys `focus`, `specificity`, `character`, `how_you_think`, `contribution`, and `self_awareness`, and no additional keys.
6. WHEN the Essay_Evaluator returns an Evaluation_Result, THE Essay_Evaluator SHALL represent each Dimension entry as an object containing a `score` that is a finite number greater than or equal to 0, a `span` that is a non-empty string, and a `reasoning` that is a non-empty string.

### Requirement 2: Reject empty essay input before any LLM call

**User Story:** As an EasyDawg admissions reviewer, I want empty essays rejected immediately, so that no evaluation effort is spent on missing input.

#### Acceptance Criteria

1. IF the Essay_Text is empty or contains only whitespace characters, THEN THE Essay_Evaluator SHALL throw an `EssayRequiredError` before any LLM request is made.

### Requirement 3: Score each dimension against its base value

**User Story:** As an EasyDawg admissions reviewer, I want each rubric dimension scored against a fixed base value, so that scores are comparable across applications.

#### Acceptance Criteria

1. WHEN the Essay_Evaluator scores the Focus Dimension, THE Essay_Evaluator SHALL compute the score against a Base_Value of 25.
2. WHEN the Essay_Evaluator scores the Specificity Dimension, THE Essay_Evaluator SHALL compute the score against a Base_Value of 25.
3. WHEN the Essay_Evaluator scores the Character Dimension, THE Essay_Evaluator SHALL compute the score against a Base_Value of 20.
4. WHEN the Essay_Evaluator scores the How_You_Think Dimension, THE Essay_Evaluator SHALL compute the score against a Base_Value of 20.
5. WHEN the Essay_Evaluator scores the Contribution Dimension, THE Essay_Evaluator SHALL compute the score against a Base_Value of 15.
6. WHEN the Essay_Evaluator scores the Self_Awareness Dimension, THE Essay_Evaluator SHALL compute the score against a Base_Value of 10.

### Requirement 4: Apply profile modifiers to dimension scores

**User Story:** As an EasyDawg admissions reviewer, I want intake-profile modifiers applied to the dimension scores, so that the evaluation reflects the applicant's context.

#### Acceptance Criteria

1. WHEN the Essay_Evaluator has computed every Dimension score against its Base_Value, THE Essay_Evaluator SHALL apply the Profile_Modifiers to those Dimension scores before producing the Evaluation_Result.
2. WHERE a Profile_Modifiers key matches a Dimension name by exact case-insensitive comparison to that Dimension's name, THE Essay_Evaluator SHALL add the numeric value associated with the key to that Dimension's score.
3. WHEN the Essay_Evaluator adds a Profile_Modifiers value to a Dimension score, THE Essay_Evaluator SHALL clamp the resulting score to the inclusive range 0 to that Dimension's Base_Value.
4. WHERE a Profile_Modifiers key does not match any of the six Dimension names by exact case-insensitive comparison, THE Essay_Evaluator SHALL leave every Dimension score unchanged for that key.
5. WHERE the Profile_Modifiers object contains no keys, THE Essay_Evaluator SHALL set the Dimension scores in the Evaluation_Result to the scores computed against the Base_Values with no modifier adjustment applied.

### Requirement 5: Use the shape classification to anchor the Focus dimension

**User Story:** As an EasyDawg admissions reviewer, I want the Focus dimension evaluated according to the essay's narrative shape, so that linear and motif essays are judged by appropriate anchors.

#### Acceptance Criteria

1. WHEN the Essay_Evaluator evaluates the Focus Dimension, THE Essay_Evaluator SHALL select the Focus anchors that correspond to the supplied Shape value.
2. WHILE the Shape value is `"linear"`, THE Essay_Evaluator SHALL evaluate the Focus Dimension using the linear Focus anchors.
3. WHILE the Shape value is `"motif"`, THE Essay_Evaluator SHALL evaluate the Focus Dimension using the motif Focus anchors.

### Requirement 6: Enforce a verbatim span for every dimension score

**User Story:** As an EasyDawg admissions reviewer, I want every dimension score anchored to an exact quote from the essay, so that each score is traceable to concrete evidence.

#### Acceptance Criteria

1. WHEN the Essay_Evaluator produces a Dimension entry, THE Essay_Evaluator SHALL set the entry's `span` to an exact, case-sensitive, character-for-character verbatim substring of the Essay_Text that preserves the original whitespace and punctuation.
2. WHEN the Essay_Evaluator produces a Dimension entry, THE Essay_Evaluator SHALL require the entry's `span` to be a non-empty string.
3. IF any Dimension entry's `span` is empty or is not an exact substring of the Essay_Text, THEN THE Essay_Evaluator SHALL reject the LLM response and issue a retry request, up to a maximum of 2 retry attempts beyond the initial request.
4. IF the maximum of 2 retry attempts is exhausted and any Dimension entry's `span` is still empty or not an exact substring of the Essay_Text, THEN THE Essay_Evaluator SHALL throw an `InvalidResponseError` that names the offending Dimension and reports the invalid `span` value, and SHALL NOT return an Evaluation_Result.
5. THE Essay_Evaluator SHALL perform the verbatim-span check as a deterministic validation independent of the LLM.

### Requirement 7: Produce exactly three sentence-level revisions

**User Story:** As an EasyDawg admissions reviewer, I want exactly three sentence-level rewrites of existing sentences, so that the feedback is focused and never invents new content.

#### Acceptance Criteria

1. WHEN the Essay_Evaluator produces the Evaluation_Result, THE Essay_Evaluator SHALL include exactly three Revision entries in the `revisions` list.
2. WHEN the Essay_Evaluator produces a Revision entry, THE Essay_Evaluator SHALL represent the entry as an object containing a string `original`, a string `suggested`, and a string `reasoning`.
3. WHEN the Essay_Evaluator produces a Revision entry, THE Essay_Evaluator SHALL set the entry's `original` to an exact verbatim substring of the Essay_Text.
4. IF the LLM response contains a number of Revision entries other than three, OR any Revision entry's `original` is not an exact substring of the Essay_Text, THEN THE Essay_Evaluator SHALL reject the LLM response and issue a retry request, up to a maximum of 2 retries.
5. IF the maximum of 2 retries is exhausted and the Revision count is still not exactly three, OR any Revision entry's `original` is still not an exact substring of the Essay_Text, THEN THE Essay_Evaluator SHALL throw an `InvalidResponseError` and SHALL NOT return an Evaluation_Result.
6. THE Essay_Evaluator SHALL perform the revision-count check as a deterministic validation independent of the LLM.
7. THE Essay_Evaluator SHALL perform the `original`-substring check as a deterministic validation independent of the LLM.

### Requirement 8: Perform the mechanics check

**User Story:** As an EasyDawg admissions reviewer, I want a grammar and spelling assessment, so that I can see whether the essay meets mechanical standards.

#### Acceptance Criteria

1. WHEN the Essay_Evaluator produces the Evaluation_Result, THE Essay_Evaluator SHALL set `mechanics_pass` to a JSON boolean.
2. WHEN the Essay_Evaluator produces the Evaluation_Result, THE Essay_Evaluator SHALL set `mechanics_errors` to a list of strings.
3. WHILE `mechanics_pass` is `true`, THE Essay_Evaluator SHALL set `mechanics_errors` to an empty list.
4. WHILE `mechanics_pass` is `false`, THE Essay_Evaluator SHALL include in `mechanics_errors` at least one string describing a mechanics error.

### Requirement 9: Output applicable UW resource-hub claim identifiers

**User Story:** As an EasyDawg admissions reviewer, I want the claim identifiers that back the feedback, so that I can trace each point to a UW resource-hub claim.

#### Acceptance Criteria

1. WHEN the Essay_Evaluator produces the Evaluation_Result, THE Essay_Evaluator SHALL set `claims` to a list of Claim_Id strings generated during the evaluation.
2. WHERE no UW resource-hub claim applies to the feedback, THE Essay_Evaluator SHALL set `claims` to an empty list.
3. WHEN the Essay_Evaluator produces a Claim_Id in the `claims` list, THE Essay_Evaluator SHALL output that Claim_Id as an opaque string and SHALL NOT resolve, match, or validate that Claim_Id against any external resource hub.
4. THE Essay_Evaluator SHALL delegate all matching, resolution, and validation of each Claim_Id against the UW resource hub to the frontend consumer of the Evaluation_Result.

### Requirement 10: Isolate the LLM call behind an injectable seam

**User Story:** As a developer maintaining EasyDawg, I want the model call isolated behind an injectable seam, so that the deterministic logic can be tested without a live model and the real binding can be plugged in later.

#### Acceptance Criteria

1. THE Essay_Evaluator SHALL route every LLM call through a single injectable module-level LLM_Seam.
2. THE Essay_Evaluator SHALL expose a `setLlmCall` function that replaces the LLM_Seam implementation.
3. WHERE no LLM_Seam implementation has been injected via `setLlmCall`, THE Essay_Evaluator SHALL use a default stub that throws an error indicating the Kiro LLM SDK binding is not configured.
4. THE Essay_Evaluator SHALL supply the fixed `SYSTEM_PROMPT` constant, which encodes the scoring rules, as the system instruction for every LLM call.

### Requirement 11: Enforce the LLM response timeout

**User Story:** As an EasyDawg admissions reviewer, I want evaluations to time out, so that a stalled model call does not hang the review.

#### Acceptance Criteria

1. THE Essay_Evaluator SHALL wait no longer than `LLM_TIMEOUT_MS` milliseconds for an LLM response.
2. IF no LLM response arrives within `LLM_TIMEOUT_MS` milliseconds, THEN THE Essay_Evaluator SHALL throw an `EvaluationTimeoutError`.
3. WHEN the LLM_Timeout elapses, THE Essay_Evaluator SHALL abort the in-flight LLM call through an abort signal.

### Requirement 12: Report LLM request failures

**User Story:** As an EasyDawg admissions reviewer, I want a clear error when the model call fails, so that I can distinguish transport failures from invalid output.

#### Acceptance Criteria

1. IF the LLM request fails with a transport error or rejection that is not a timeout, THEN THE Essay_Evaluator SHALL throw an `EvaluationFailedError`.

### Requirement 13: Parse and validate the LLM response deterministically

**User Story:** As a developer maintaining EasyDawg, I want parsing and validation kept separate and strict, so that a malformed response produces a specific, actionable error.

#### Acceptance Criteria

1. THE Essay_Evaluator SHALL perform response parsing as a stage separate from response validation.
2. IF the LLM response text is not well-formed JSON, THEN THE Essay_Evaluator SHALL throw an `InvalidResponseError` whose message identifies the JSON syntax fault.
3. IF the parsed response is missing a required field of the Evaluation_Result, THEN THE Essay_Evaluator SHALL throw an `InvalidResponseError` naming the missing field.
4. IF a field of the parsed response has a type other than the type required by the Evaluation_Result schema, THEN THE Essay_Evaluator SHALL throw an `InvalidResponseError` naming the field and its invalid value.
5. THE Essay_Evaluator SHALL treat the LLM response schema as excluding `band`, SHALL NOT parse `band` from the LLM response, and SHALL restrict the required-field validation to the LLM-provided fields: the six `dimensions` entries each with a `score`, a `span`, and a `reasoning`; `mechanics_pass`; `mechanics_errors`; `revisions`; and `claims`.
6. THE Essay_Evaluator SHALL perform validation without coercing or defaulting any field of the parsed response.

### Requirement 14: Derive the overall band from the total score

**User Story:** As an EasyDawg admissions reviewer, I want the overall band derived deterministically from the dimension scores, so that two implementations produce identical bands and the rating does not depend on the LLM's discretion.

#### Acceptance Criteria

1. WHEN the Essay_Evaluator has finalized all six Dimension scores after applying Profile_Modifiers, THE Essay_Evaluator SHALL compute the Total_Score as the sum of the six finalized Dimension scores, out of a maximum total of 115.
2. WHEN the Essay_Evaluator computes the Total_Score, THE Essay_Evaluator SHALL derive the `band` by mapping the Total_Score onto the 1 to 5 scale using five equal bands of 23 points each.
3. WHILE the Total_Score is in the inclusive range 0 to 23, THE Essay_Evaluator SHALL set the `band` to 1.
4. WHILE the Total_Score is in the inclusive range 24 to 46, THE Essay_Evaluator SHALL set the `band` to 2.
5. WHILE the Total_Score is in the inclusive range 47 to 69, THE Essay_Evaluator SHALL set the `band` to 3.
6. WHILE the Total_Score is in the inclusive range 70 to 92, THE Essay_Evaluator SHALL set the `band` to 4.
7. WHILE the Total_Score is in the inclusive range 93 to 115, THE Essay_Evaluator SHALL set the `band` to 5.
8. THE Essay_Evaluator SHALL compute the `band` as a deterministic calculation from the finalized Dimension scores, independent of the LLM, such that the LLM does not select the `band` value.
