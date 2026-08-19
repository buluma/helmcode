import type { ModelCapabilities, ServerProviderModel } from "@helmcode/contracts";
import { createModelCapabilities } from "@helmcode/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const OPENROUTER_PRESENTATION = {
  displayName: "OpenRouter",
  showInteractionModeToggle: false,
  supportsMultiAgentWorkflow: false,
} as const;

const DEFAULT_OPENROUTER_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

class OpenRouterProbeError extends Error {
  constructor(
    readonly detail: string,
    readonly cause: unknown,
  ) {
    super(`OpenRouter probe failed: ${detail}`);
    this.name = "OpenRouterProbeError";
  }
}

function normalizeOpenRouterErrorMessage(cause: unknown): string | undefined {
  const message =
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof (cause as { readonly message?: unknown }).message === "string"
      ? ((cause as { readonly message: string }).message ?? "").trim()
      : typeof cause === "string"
        ? cause.trim()
        : "";
  return message.length > 0 ? message : undefined;
}

function formatOpenRouterProbeError(input: {
  cause: unknown;
  isExternalServer: boolean;
  serverUrl: string;
}): { readonly installed: boolean; readonly message: string } {
  const detail = normalizeOpenRouterErrorMessage(input.cause);
  const lower = detail?.toLowerCase() ?? "";

  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return {
      installed: true,
      message: "OpenRouter rejected authentication. Check the API key in settings.",
    };
  }

  if (
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed") ||
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("socket hang up") ||
    lower.includes("networkerror")
  ) {
    return {
      installed: true,
      message: `Couldn't reach OpenRouter at ${input.serverUrl}. Check the base URL and network.`,
    };
  }

  return {
    installed: true,
    message: detail ?? "Failed to connect to OpenRouter.",
  };
}

function flattenOpenRouterModels(responseData: unknown): readonly ServerProviderModel[] {
  const data = (responseData as Record<string, unknown>)?.data;
  const list = Array.isArray(data) ? data : [];

  return list.map((model) => {
    const rawId = (model as Record<string, unknown>)?.id;
    const rawName = (model as Record<string, unknown>)?.name;
    const id = typeof rawId === "string" ? rawId.trim() : "";
    const name = typeof rawName === "string" && rawName.trim().length > 0 ? rawName.trim() : id;
    const slashIndex = id.indexOf("/");
    const subProvider = slashIndex >= 0 ? id.slice(0, slashIndex).trim() : undefined;
    return {
      slug: id,
      name,
      subProvider: subProvider && subProvider.length > 0 ? subProvider : undefined,
      isCustom: false,
      capabilities: null,
    };
  });
}

export const makePendingOpenRouterProvider = (input: {
  readonly enabled: boolean;
  readonly customModels: readonly string[];
}): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = providerModelsFromSettings(
      [],
      input.customModels,
      DEFAULT_OPENROUTER_MODEL_CAPABILITIES,
    );

    if (!input.enabled) {
      return buildServerProvider({
        presentation: OPENROUTER_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "OpenRouter is disabled in Helm Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: OPENROUTER_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "OpenRouter provider status has not been checked in this session yet.",
      },
    });
  });

export const checkOpenRouterProviderStatus = (
  input: {
    readonly enabled: boolean;
    readonly apiKey: string;
    readonly baseUrl: string;
    readonly customModels: readonly string[];
  },
  cwd: string,
  httpClient: HttpClient.HttpClient,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const customModels = input.customModels;
    const isExternalServer = input.baseUrl.trim().length > 0;

    const fallback = (errorCause: unknown): ServerProviderDraft => {
      const failure = formatOpenRouterProbeError({
        cause: errorCause,
        isExternalServer,
        serverUrl: input.baseUrl,
      });
      return buildServerProvider({
        presentation: OPENROUTER_PRESENTATION,
        enabled: input.enabled,
        checkedAt,
        models: providerModelsFromSettings([], customModels, DEFAULT_OPENROUTER_MODEL_CAPABILITIES),
        probe: {
          installed: failure.installed,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: failure.message,
        },
      });
    };

    if (!input.enabled) {
      return buildServerProvider({
        presentation: OPENROUTER_PRESENTATION,
        enabled: false,
        checkedAt,
        models: providerModelsFromSettings([], customModels, DEFAULT_OPENROUTER_MODEL_CAPABILITIES),
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: isExternalServer
            ? "OpenRouter is disabled in Helm Code settings. A base URL is configured."
            : "OpenRouter is disabled in Helm Code settings.",
        },
      });
    }

    const probe = Effect.gen(function* () {
      const request = HttpClientRequest.post(`${input.baseUrl.replace(/\/$/, "")}/models`).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${input.apiKey}`),
        HttpClientRequest.setHeader("Content-Type", "application/json"),
      );

      const response = yield* httpClient.execute(request);

      if (response.status !== 200) {
        const text = yield* response.text;
        throw new OpenRouterProbeError(
          `HTTP ${response.status}: ${text.trim().length > 0 ? text.trim() : String(response.status)}`,
          new Error(`HTTP ${response.status}`),
        );
      }

      const responseText = yield* response.text;
      const parsed = JSON.parse(responseText) as Record<string, unknown>;
      return parsed;
    }).pipe(
      Effect.mapError((cause) => {
        if (cause instanceof OpenRouterProbeError) return cause;
        return new OpenRouterProbeError(
          cause instanceof Error ? cause.message : String(cause),
          cause,
        );
      }),
    );

    const probeExit = yield* Effect.exit(probe);

    if (Exit.isFailure(probeExit)) {
      return fallback(probeExit.cause);
    }

    const models = providerModelsFromSettings(
      flattenOpenRouterModels(probeExit.value),
      customModels,
      DEFAULT_OPENROUTER_MODEL_CAPABILITIES,
    );

    return buildServerProvider({
      presentation: OPENROUTER_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: models.length > 0 ? "ready" : "warning",
        auth: {
          status: models.length > 0 ? "authenticated" : "unknown",
          type: "openrouter",
        },
        message:
          models.length > 0
            ? `${models.length} model${models.length === 1 ? "" : "s"} available through OpenRouter.`
            : "Connected to OpenRouter, but no models were returned.",
      },
    });
  });
