# Stamp `maxTokens` into OpenCode's token-usage snapshot

## Problem

The `ContextWindowMeter` in `apps/web/src/components/chat/ContextWindowMeter.tsx`
renders an empty ring and shows bare token count when `usage.maxTokens` is
`null`. OpenCode always emits this state because
`openCodeTokenUsageSnapshot` (`apps/server/src/provider/Layers/OpenCodeAdapter.ts:539`)
returns a `ThreadTokenUsageSnapshot` without `maxTokens`. Result: the meter
silently breaks for the OpenCode driver while Claude (which stamps it at
`Layers/ClaudeAdapter.ts:548`) works correctly.

The cap is already available — every
`ProviderListResponse.all[*].models[*].limit.context` carries it
(`node_modules/.pnpm/@opencode-ai+sdk@1.15.13/.../dist/gen/types.gen.d.ts:1323-1326`),
and every `AssistantMessage` carries `providerID` + `modelID`
(`types.gen.d.ts:108-109`). The adapter just doesn't read either.

## Approach

Load the OpenCode inventory (`provider.list`) into session context once at
session start, look up the cap per assistant message, stamp it. Fire-and-forget
the inventory load so a slow/failing `provider.list` doesn't kill the session
— the meter just shows bare counts until something succeeds.

## File-by-file changes

### `apps/server/src/provider/Layers/OpenCodeAdapter.ts`

**1. Add imports.** Top of file, alongside the existing `runOpenCodeSdk` import
from `../opencodeRuntime.ts`:

```ts
import {
  loadOpenCodeInventory,
  // ...existing imports
} from "../opencodeRuntime.ts";
```

**2. Extend `OpenCodeSessionContext`** (interface at line 215-261) with two
fields:

```ts
/**
 * Per-model context window caps, in tokens. Keyed by `"<providerID>/<modelID>"`.
 * Populated once per session from `provider.list` so each assistant message can
 * stamp `maxTokens` into the token-usage snapshot without re-querying the SDK.
 * Empty when the inventory load failed — the meter then degrades to the
 * bare-count UI it had before.
 */
readonly modelLimits: Map<string, number>;
/**
 * Last `<providerID>/<modelID>` we observed on a `message.updated`. Reserved
 * for a future model-swap detector; unused in this PR.
 */
lastObservedModelKey: string | undefined;
```

**3. Initialize the new fields** in the `OpenCodeSessionContext` constructor
at line 1752-1771:

```ts
const context: OpenCodeSessionContext = {
  // ...existing fields...
  modelLimits: new Map(),
  lastObservedModelKey: undefined,
  stopped: yield * Ref.make(false),
  sessionScope: started.sessionScope,
};
```

**4. Load inventory after `sessions.set(...)`** (around line 1772), forked
into `context.sessionScope` so closing the session interrupts the load:

```ts
yield *
  Effect.forkIn(
    Effect.gen(function* () {
      const inventory = yield* loadOpenCodeInventory(started.client).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (!inventory) return;
      const limits = new Map<string, number>();
      for (const provider of inventory.providerList.all) {
        for (const model of Object.values(provider.models)) {
          const ctx = model.limit?.context;
          if (typeof ctx === "number" && ctx > 0) {
            limits.set(`${provider.id}/${model.id}`, ctx);
          }
        }
      }
      context.modelLimits = limits;
    }),
    context.sessionScope,
  );
```

**5. Modify `openCodeTokenUsageSnapshot`** (line 539-561) to accept the
limits map and stamp `maxTokens`:

```ts
export function openCodeTokenUsageSnapshot(
  info: AssistantMessage,
  modelLimits?: ReadonlyMap<string, number>,
): ThreadTokenUsageSnapshot | undefined {
  const tokens = info.tokens as Partial<AssistantMessage["tokens"]> | undefined;
  if (!tokens || typeof tokens !== "object") {
    return undefined;
  }
  const input = typeof tokens.input === "number" ? tokens.input : 0;
  const output = typeof tokens.output === "number" ? tokens.output : 0;
  const reasoning = typeof tokens.reasoning === "number" ? tokens.reasoning : 0;
  const cachedRead = typeof tokens.cache?.read === "number" ? tokens.cache.read : 0;
  const usedTokens = typeof tokens.total === "number" ? tokens.total : input + output + reasoning;
  if (usedTokens <= 0) {
    return undefined;
  }
  const maxTokens = modelLimits?.get(`${info.providerID}/${info.modelID}`);
  return {
    usedTokens,
    ...(input > 0 ? { inputTokens: input } : {}),
    ...(output > 0 ? { outputTokens: output } : {}),
    ...(reasoning > 0 ? { reasoningOutputTokens: reasoning } : {}),
    ...(cachedRead > 0 ? { cachedInputTokens: cachedRead } : {}),
    ...(typeof maxTokens === "number" && maxTokens > 0 ? { maxTokens: Math.round(maxTokens) } : {}),
  };
}
```

`ThreadTokenUsageSnapshot.maxTokens` is `Schema.optional(PositiveInt)` per
`packages/contracts/src/providerRuntime.ts:312` — the runtime guard is
`>0`, plus rounding in case an SDK ever emits a fractional cap.

**6. Pass the limits map at the `message.updated` handler** (line 900):

```ts
const tokenUsage = openCodeTokenUsageSnapshot(event.properties.info, context.modelLimits);
```

## Tests

### `apps/server/src/provider/Layers/OpenCodeAdapter.test.ts`

Extend the existing `it.effect("maps an assistant message's tokens/cost into a ThreadTokenUsageSnapshot", ...)` block at line 4327-4389. Append three sub-asserts:

1. Matching limits map → `maxTokens` lands in the snapshot.
2. Mismatched key → no `maxTokens`, baseline unchanged.
3. Limits map with zero/negative entries → ignored, no `maxTokens`.

```ts
const limits = new Map([
  ["openai/gpt-5", 200_000],
  ["anthropic/claude-sonnet-5", 1_000_000],
]);

NodeAssert.deepEqual(
  openCodeTokenUsageSnapshot(
    {
      ...baseInfo,
      cost: 0.0042,
      tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 5, write: 0 } },
    } as AssistantMessage,
    limits,
  ),
  {
    usedTokens: 150,
    inputTokens: 100,
    outputTokens: 40,
    reasoningOutputTokens: 10,
    cachedInputTokens: 5,
    maxTokens: 200_000,
  },
);

// Unknown model → no maxTokens even if map has other entries.
NodeAssert.deepEqual(
  openCodeTokenUsageSnapshot(
    {
      ...baseInfo,
      modelID: "gpt-5-mini",
      cost: 0,
      tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as AssistantMessage,
    limits,
  ),
  { usedTokens: 1, inputTokens: 1 },
);

// Zero / negative entries in the map are ignored — schema says PositiveInt.
NodeAssert.deepEqual(
  openCodeTokenUsageSnapshot(
    {
      ...baseInfo,
      cost: 0,
      tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as AssistantMessage,
    new Map([["openai/gpt-5", 0]]),
  ),
  { usedTokens: 1, inputTokens: 1 },
);
```

Add one end-to-end assertion: with `runtimeMock` SDK client patched to return
a single-model `provider.list` response, push an assistant `message.updated`
through `subscribedEvents`, read the resulting `thread.token-usage.updated`
from `runtimeMock.events`, and assert `usage.maxTokens` matches the mocked
cap.

## Validation

Per repo AGENTS.md "Verifying" section — smallest proof, no repo-wide.

```
vp test run apps/server/src/provider/Layers/OpenCodeAdapter.test.ts
vp test run apps/web/src/lib/contextWindow.test.ts
vp test run apps/web/src/components/chat/ContextWindowMeter.test.ts
```

Manual smoke (do not commit automation for this):

1. Copy `~/.helmcode/userdata` into the worktree's `.helmcode/userdata` via
   `VACUUM INTO` (per repo AGENTS.md "Test data").
2. `vp run dev` in the worktree.
3. Start a thread with `driverKind: opencode`, send a message, watch the
   composer meter. Confirm the ring fills and the percent label appears once
   the assistant message lands.
4. Switch to a thread with a model that has no `limit.context` entry (e.g. an
   external OpenCode-compatible provider with no `limit` field). Confirm the
   meter still shows the bare count, not a broken ring.

If any of those fail, stop and revise the patch — don't paper over with
sleeps or skip-on-fail.

## Risks

Low. `ThreadTokenUsageSnapshot.maxTokens` is already an optional field in the
contract, so consumers that ignore the new key are unaffected. The schema
change is purely additive.

- **Inventory-load race window.** Between session start and the inventory
  fork completing (a few hundred ms warm, longer on cold spawn), the first
  assistant message may land before the map is populated. That one message
  shows bare count. Acceptable for v1; tighten later if telemetry shows it
  matters.
- **Mid-session model swap.** Rare but possible via the `variant`/`agent`
  selectors. `lastObservedModelKey` is reserved as a hook for a follow-up
  refresh path; this PR does not implement it.
- **External server without `provider.list` access.** The map stays empty, the
  meter degrades to current behavior. No regression vs. today.

## Out of scope (separate concerns)

- **Other providers.** Codex emits `maxTokens` only in tests, not in production
  (`apps/server/src/provider/Layers/CodexAdapter.ts:1009`). OpenAI-compatible
  adapters in `OpenAICompatibleWorkspaceAdapter.ts:851` similarly emit
  `usedTokens` only. Same one-line fix pattern applies; separate PRs.
- **Meter UX for unknown cap.** When `maxTokens` is missing, the ring still
  renders empty. A spinner or "—" state would be more honest; separate UX
  ticket.
- **`docs/internals/providers.md` table update.** Still says 5 drivers; the
  actual count is 7. Flag for the next provider-internals PR.
