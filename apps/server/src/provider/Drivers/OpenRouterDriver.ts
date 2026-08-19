/**
 * OpenRouterDriver — `ProviderDriver` for the OpenRouter API.
 *
 * Registers an OpenRouter-backed `ProviderInstance` by wiring the
 * API-only probe/adapter/text-generation trio together.
 *
 * @module provider/Drivers/OpenRouterDriver
 */
import { OpenRouterSettings, ProviderDriverKind, type ServerProvider } from "@helmcode/contracts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/unstable/http";
import * as Schema from "effect/Schema";

import { makeOpenAICompatibleTextGeneration } from "../../textGeneration/OpenAICompatibleTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import type { OpenRouterAdapterShape } from "../Services/OpenRouterAdapter.ts";
import { makeOpenRouterAdapter } from "../Layers/OpenRouterAdapter.ts";
import {
  checkOpenRouterProviderStatus,
  makePendingOpenRouterProvider,
} from "../Layers/OpenRouterProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodeOpenRouterSettings = Schema.decodeSync(OpenRouterSettings);

const DRIVER_KIND = ProviderDriverKind.make("openrouter");

export type OpenRouterDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | Crypto.Crypto
  | HttpClient.HttpClient
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const OpenRouterDriver: ProviderDriver<OpenRouterSettings, OpenRouterDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenRouter",
    supportsMultipleInstances: true,
  },
  configSchema: OpenRouterSettings,
  defaultConfig: (): OpenRouterSettings => decodeOpenRouterSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const httpClient = yield* HttpClient.HttpClient;
      const effectiveConfig = { ...config, enabled } satisfies OpenRouterSettings;

      const adapterInstance = yield* makeOpenRouterAdapter({
        apiKey: effectiveConfig.apiKey,
        baseUrl: effectiveConfig.baseUrl,
        defaultModel: "openai/gpt-4o-mini",
      });

      const textGeneration = makeOpenAICompatibleTextGeneration({
        apiKey: effectiveConfig.apiKey,
        baseUrl: effectiveConfig.baseUrl,
        defaultModel: "openai/gpt-4o-mini",
      });

      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OpenRouterSettings>>({
        maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
          provider: DRIVER_KIND,
          packageName: null,
        }),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingOpenRouterProvider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider: checkOpenRouterProviderStatus(
            effectiveConfig,
            serverConfig.cwd,
            httpClient,
          ).pipe(Effect.map(stampIdentity)),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build OpenRouter snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter: adapterInstance,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};