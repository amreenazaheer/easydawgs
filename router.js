/**
 * Deterministic Intake Router for the EasyDawg admissions evaluator.
 *
 * No LLM calls are used in this file. All logic is pure and deterministic:
 * the same StudentProfile input always produces the same output.
 *
 * Browser-native ES module. 1:1 port of router.ts with TypeScript types stripped.
 */

/**
 * Evaluates a student profile and returns weight modifiers and hard flags.
 *
 * @param {object} profile The student's intake profile.
 * @returns {{ modifiers: Object<string, number>, flags: string[] }} An object
 *   containing accumulated weight modifiers and hard flags.
 */
export function evaluateProfile(profile) {
  const modifiers = {};
  const flags = [];

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
 *
 * @param {Object<string, number>} modifiers
 * @param {string} key
 * @param {number} weight
 * @returns {void}
 */
function addModifier(modifiers, key, weight) {
  modifiers[key] = (modifiers[key] ?? 0) + weight;
}
