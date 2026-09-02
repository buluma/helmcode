/**
 * Whimsical single-word verbs shown while a thread is generating, mirroring
 * Claude Code's CLI spinner. Kept generic (no product-specific jokes) since
 * this ships to every helmcode user, not just one person's local config.
 */
export const SPINNER_VERBS: readonly string[] = [
  "Pondering",
  "Noodling",
  "Marinating",
  "Cogitating",
  "Percolating",
  "Ruminating",
  "Mulling",
  "Brewing",
  "Simmering",
  "Tinkering",
  "Puzzling",
  "Synthesizing",
  "Deliberating",
  "Contemplating",
  "Scheming",
  "Working",
];

export function pickRandomSpinnerVerb(exclude?: string): string {
  if (SPINNER_VERBS.length <= 1) return SPINNER_VERBS[0] ?? "Working";
  let next = SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)];
  while (next === exclude) {
    next = SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)];
  }
  return next ?? "Working";
}
