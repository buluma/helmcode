/**
 * NVIDIA NIM's chat-completions adapter -- a thin instantiation of the
 * shared OpenAI-compatible workspace-tool factory. See
 * OpenAICompatibleWorkspaceAdapter.ts for the actual implementation; this
 * file exists only to name the NVIDIA-specific `providerKind`/`providerLabel`
 * and re-export the result under the name NvidiaDriver.ts expects.
 *
 * @module provider/Layers/NvidiaAdapter
 */
import { ProviderDriverKind } from "@helmcode/contracts";

import { makeOpenAICompatibleWorkspaceAdapter } from "./OpenAICompatibleWorkspaceAdapter.ts";

export const makeNvidiaAdapter = makeOpenAICompatibleWorkspaceAdapter({
  providerKind: ProviderDriverKind.make("nvidia"),
  providerLabel: "NVIDIA",
});
