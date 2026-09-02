import { describe, expect, it } from "vite-plus/test";

import { pickRandomSpinnerVerb, SPINNER_VERBS } from "./spinnerVerbs";

describe("pickRandomSpinnerVerb", () => {
  it("always returns one of the known verbs", () => {
    for (let i = 0; i < 50; i++) {
      expect(SPINNER_VERBS).toContain(pickRandomSpinnerVerb());
    }
  });

  it("never repeats the excluded verb back-to-back", () => {
    for (const verb of SPINNER_VERBS) {
      for (let i = 0; i < 20; i++) {
        expect(pickRandomSpinnerVerb(verb)).not.toBe(verb);
      }
    }
  });
});
