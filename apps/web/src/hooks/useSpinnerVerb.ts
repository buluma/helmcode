import { useEffect, useRef, useState } from "react";
import { pickRandomSpinnerVerb } from "~/lib/spinnerVerbs";

const ROTATE_INTERVAL_MS = 2_500;

/**
 * Rotating whimsical verb ("Pondering", "Noodling", ...) for the duration
 * `active` stays true. Picks a fresh verb on activation and every
 * ROTATE_INTERVAL_MS afterward; returns null while inactive so callers don't
 * have to special-case an idle placeholder.
 */
export function useSpinnerVerb(active: boolean): string | null {
  const [verb, setVerb] = useState<string | null>(null);
  const verbRef = useRef<string | null>(null);
  verbRef.current = verb;

  useEffect(() => {
    if (!active) {
      setVerb(null);
      return;
    }
    setVerb((current) => current ?? pickRandomSpinnerVerb());
    const timer = window.setInterval(() => {
      setVerb(pickRandomSpinnerVerb(verbRef.current ?? undefined));
    }, ROTATE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active]);

  return verb;
}
