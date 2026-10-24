/**
 * Deterministic Intake Router for the EasyDawg admissions evaluator.
 *
 * No LLM calls are used in this file. All logic is pure and deterministic:
 * the same StudentProfile input always produces the same output.
 */

export interface StudentProfile {
  hasGradeDip: boolean;
  activityCount: number;
  hasCommunityActivity: boolean;
  majorChoice1: string;
  majorChoice2: string;
  isMajor2DirectToMajor: boolean;
  contextBoxesUsed: number;
  hasSeniorSchedule: boolean;
  isRunningStart: boolean;
  hasReducedSeniorRigor: boolean;
}

export interface EvaluationResult {
  modifiers: Record<string, number>;
  flags: string[];
}

/**
 * Evaluates a student profile and returns weight modifiers and hard flags.
 *
 * @param profile The student's intake profile.
 * @returns An object containing accumulated weight modifiers and hard flags.
 */
export function evaluateProfile(profile: StudentProfile): EvaluationResult {
  const modifiers: Record<string, number> = {};
  const flags: string[] = [];

  // --- Weight Modifiers Logic ---

  if (profile.hasGradeDip) {
    addModifier(modifiers, "Character", 1);
  }

  if (profile.activityCount < 6) {
    addModifier(modifiers, "Contribution", 1);
  }

  if (!profile.hasCommunityActivity) {
    addModifier(modifiers, "Contribution", 1);
  }

  // --- Hard Flags Logic ---

  if (profile.isMajor2DirectToMajor) {
    flags.push(
      "Second-choice major is a direct-to-major option. A second choice opens general admission review only."
    );
  }

  if (
    profile.majorChoice1.includes("Allen School") &&
    profile.majorChoice2.includes("Allen School")
  ) {
    flags.push(
      "Both choices are Allen School majors — no second consideration exists."
    );
  }

  if (profile.activityCount < 10) {
    flags.push("Fewer than 10 activity slots used.");
  }

  if (profile.hasGradeDip && profile.contextBoxesUsed === 0) {
    flags.push("Grade anomaly with both context boxes empty.");
  }

  if (!profile.hasSeniorSchedule) {
    flags.push("No senior-year schedule entered.");
  }

  if (profile.isRunningStart && profile.hasReducedSeniorRigor) {
    flags.push("Running Start student with reduced senior rigor.");
  }

  return { modifiers, flags };
}

/**
 * Accumulates a weight into a modifier key, summing when the key already exists.
 */
function addModifier(
  modifiers: Record<string, number>,
  key: string,
  weight: number
): void {
  modifiers[key] = (modifiers[key] ?? 0) + weight;
}
