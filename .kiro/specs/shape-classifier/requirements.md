# Requirements Document

## Introduction

The shape-classifier feature introduces an LLM-backed module (`shape-classifier.ts`) to the EasyDawg admissions evaluator. Unlike the deterministic logic in `router.ts`, this module uses Kiro's LLM capabilities to read a student's application essay and classify its structural shape. The module exposes a single asynchronous function, `classifyShape`, that sends the essay text to the LLM with a dedicated system prompt and returns a strict JSON object describing the essay's narrative shape, whether the narrative is circular, and a brief justification. The output conforms to the project's TypeScript conventions (typed interfaces, JSDoc comments, exported functions).

## Glossary

- **Shape_Classifier**: The module (`shape-classifier.ts`) that classifies the structural shape of an essay using the LLM.
- **Essay_Text**: The raw student essay string passed to the classifier as the `essayText` argument.
- **LLM**: Kiro's large language model, invoked by the Shape_Classifier to analyze the Essay_Text.
- **System_Prompt**: The fixed instruction set supplied to the LLM that defines the classification rules for shape and circularity.
- **Classification_Result**: The strict JSON object returned by `classifyShape`, containing the fields `shape`, `circularity`, and `reasoning`.
- **Shape_Value**: The `shape` field of the Classification_Result, restricted to the string values "linear" or "motif".
- **Linear_Shape**: A Shape_Value of "linear", indicating the essay is built around unconnected episodes or a chronological timeline.
- **Motif_Shape**: A Shape_Value of "motif", indicating the essay repeatedly returns to a specific object, metaphor, or image to anchor the narrative.
- **Circularity**: The boolean `circularity` field of the Classification_Result, set to true when the ending explicitly returns to the exact opening image, scene, or question, and set to false otherwise.
- **Reasoning**: The string `reasoning` field of the Classification_Result, containing one brief sentence justifying the Shape_Value choice.

## Requirements

### Requirement 1: Classify essay shape via LLM

**User Story:** As an admissions evaluator, I want to classify the structural shape of a student essay, so that I can understand how the narrative is organized.

#### Acceptance Criteria

1. THE Shape_Classifier SHALL export an asynchronous function named `classifyShape` that accepts a single string parameter `essayText`.
2. IF `classifyShape` is invoked with an Essay_Text that is empty or contains only whitespace characters, THEN THE Shape_Classifier SHALL reject the invocation with an error indicating that Essay_Text is required, and SHALL NOT send any request to the LLM.
3. WHEN `classifyShape` is invoked with a non-empty Essay_Text, THE Shape_Classifier SHALL send the Essay_Text to the LLM together with the System_Prompt within a request that enforces a response timeout of 30 seconds.
4. WHEN the LLM returns a valid classification containing `shape`, `circularity`, and `reasoning`, THE Shape_Classifier SHALL return a Classification_Result containing the fields `shape`, `circularity`, and `reasoning`.
5. THE Shape_Classifier SHALL restrict the `shape` field of the Classification_Result to exactly one of the values "linear" or "motif".
6. THE Shape_Classifier SHALL represent the `circularity` field of the Classification_Result as a boolean value.
7. THE Shape_Classifier SHALL represent the `reasoning` field of the Classification_Result as a string value.
8. IF the LLM response is missing any of the fields `shape`, `circularity`, or `reasoning`, or the `shape` field is not one of "linear" or "motif", THEN THE Shape_Classifier SHALL reject the invocation with an error indicating that the classification response is invalid, and SHALL NOT return a Classification_Result.
9. IF the LLM request fails or does not return a response within the 30 second timeout, THEN THE Shape_Classifier SHALL reject the invocation with an error indicating that the classification could not be completed.

### Requirement 2: Apply shape classification rules

**User Story:** As an admissions evaluator, I want the classifier to apply consistent rules for shape and circularity, so that classifications are predictable and explainable.

#### Acceptance Criteria

1. WHERE the Essay_Text is built around unconnected episodes or a chronological timeline without a recurring anchoring object, metaphor, or image, THE System_Prompt SHALL instruct the LLM to assign the Shape_Value "linear".
2. WHERE the Essay_Text returns two or more times to a single specific object, metaphor, or image that anchors the narrative, THE System_Prompt SHALL instruct the LLM to assign the Shape_Value "motif".
3. WHERE the Essay_Text exhibits characteristics matching both "linear" and "motif" rules, THE System_Prompt SHALL instruct the LLM to assign the Shape_Value "motif".
4. IF the Essay_Text matches neither the "linear" nor the "motif" rule, THEN THE System_Prompt SHALL instruct the LLM to assign the Shape_Value "linear" as the default.
5. WHERE the ending of the Essay_Text explicitly returns to the exact opening image, scene, or question, THE System_Prompt SHALL instruct the LLM to set `circularity` to true.
6. WHERE the ending of the Essay_Text does not explicitly return to the exact opening image, scene, or question, THE System_Prompt SHALL instruct the LLM to set `circularity` to false.
7. THE System_Prompt SHALL instruct the LLM to provide Reasoning consisting of exactly one sentence of no more than 200 characters that names the specific textual evidence justifying the Shape_Value choice.

### Requirement 3: Produce strict JSON output

**User Story:** As a developer integrating the classifier, I want the function to return a strictly typed JSON object, so that downstream code can consume the result reliably.

#### Acceptance Criteria

1. THE Shape_Classifier SHALL define a typed interface describing the Classification_Result with the fields `shape` (restricted to "linear" or "motif"), `circularity` (a boolean), and `reasoning` (a non-empty string of at most 2000 characters).
2. WHEN the LLM returns output, THE Shape_Classifier SHALL parse the output into a Classification_Result object containing all three fields `shape`, `circularity`, and `reasoning`.
3. IF the LLM output is not well-formed JSON or is missing any of the fields `shape`, `circularity`, or `reasoning`, THEN THE Shape_Classifier SHALL raise an error that identifies the parsing failure and the specific field or syntax at fault, and SHALL return no Classification_Result.
4. IF the `shape` field of the parsed output is a value other than "linear" or "motif", THEN THE Shape_Classifier SHALL raise an error that identifies the invalid Shape_Value and SHALL return no Classification_Result.
5. IF the `circularity` field of the parsed output is not a boolean, THEN THE Shape_Classifier SHALL raise an error that identifies the invalid circularity value and SHALL return no Classification_Result.

### Requirement 4: Follow project conventions

**User Story:** As a maintainer of the EasyDawg project, I want the new module to match existing TypeScript conventions, so that the codebase stays consistent.

#### Acceptance Criteria

1. THE Shape_Classifier SHALL define an exported TypeScript interface for the Classification_Result that declares the shape, circularity, and reasoning members.
2. THE Shape_Classifier SHALL document the exported `classifyShape` function with a JSDoc comment that describes both its essayText parameter and the Classification_Result it returns.
3. THE Shape_Classifier SHALL expose `classifyShape` as a named exported async function that accepts an essayText input.
