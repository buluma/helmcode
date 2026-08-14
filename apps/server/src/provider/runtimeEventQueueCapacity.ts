/**
 * Shared capacity for the per-session runtime-event queues each provider
 * adapter keeps between its subprocess/SDK event source and the reactor that
 * drains it (ProviderRuntimeIngestion and friends). These queues used to be
 * unbounded: if a consumer ever stalled, one wedged session could grow its
 * queue without limit and OOM-kill the whole server, taking every other
 * session down with it (see the replay-gap cap in ws.ts for the same failure
 * mode on the read side).
 *
 * The cap is set far above anything a legitimate session produces — normal
 * threads emit at most low thousands of runtime events — so `Queue.offer`
 * suspending the producer here only happens in the pathological case (a
 * consumer wedged, or an adapter re-emitting events in a loop) that would
 * otherwise have grown unbounded. A bounded queue trades "one session's
 * producer blocks" for "the whole server OOMs," which is strictly better.
 */
export const PROVIDER_RUNTIME_EVENT_QUEUE_CAPACITY = 50_000;
