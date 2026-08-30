/**
 * OpenRouter's chat-completions adapter -- a thin instantiation of the
 * shared OpenAI-compatible workspace-tool factory. See
 * OpenAICompatibleWorkspaceAdapter.ts for the actual implementation; this
 * file exists only to name the OpenRouter-specific `providerKind`/
 * `providerLabel` and re-export the result under the name
 * OpenRouterDriver.ts expects.
 *
 * @module provider/Layers/OpenRouterAdapter
 */
import { ProviderDriverKind } from "@helmcode/contracts";

import { makeOpenAICompatibleWorkspaceAdapter } from "./OpenAICompatibleWorkspaceAdapter.ts";

export const makeOpenRouterAdapter = makeOpenAICompatibleWorkspaceAdapter({
  providerKind: ProviderDriverKind.make("openrouter"),
  providerLabel: "OpenRouter",
});
