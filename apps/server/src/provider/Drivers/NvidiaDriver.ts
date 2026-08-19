/**
 * NvidiaDriver — `ProviderDriver` for the NVIDIA NIM / API.
 *
 * Registers an NVIDIA-backed `ProviderInstance` by wiring the
 * API-only probe/adapter/text-generation trio together.
 *
 * @module provider/Drivers/NvidiaDriver
 */
import { NvidiaSettings, ProviderDriverKind, type ServerProvider } from "@helmcode/contracts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/unstable/http";
import * as Schema from "effect/Schema";

import { makeOpenAICompatibleTextGeneration } from "../../textGeneration/OpenAICompatibleTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeNvidiaAdapter } from "../Layers/NvidiaAdapter.ts";
import { checkNvidiaProviderStatus, makePendingNvidiaProvider } from "../Layers/NvidiaProvider.ts";
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

const decodeNvidiaSettings = Schema.decodeSync(NvidiaSettings);

const DRIVER_KIND = ProviderDriverKind.make("nvidia");

export type NvidiaDriverEnv =
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

export const NvidiaDriver: ProviderDriver<NvidiaSettings, NvidiaDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "NVIDIA",
    supportsMultipleInstances: true,
  },
  configSchema: NvidiaSettings,
  defaultConfig: (): NvidiaSettings => decodeNvidiaSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const _crypto = yield* Crypto.Crypto;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const _eventLoggers = yield* ProviderEventLoggers;
      const effectiveConfig = { ...config, enabled } satisfies NvidiaSettings;

      const httpClient = yield* HttpClient.HttpClient;

      const adapterInstance = yield* makeNvidiaAdapter({
        apiKey: effectiveConfig.apiKey,
        baseUrl: effectiveConfig.baseUrl,
        defaultModel: "meta/llama-3.1-70b-instruct",
      });

      const textGeneration = yield* makeOpenAICompatibleTextGeneration({
        apiKey: effectiveConfig.apiKey,
        baseUrl: effectiveConfig.baseUrl,
        defaultModel: "meta/llama-3.1-70b-instruct",
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
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<NvidiaSettings>>({
        maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
          provider: DRIVER_KIND,
          packageName: null,
        }),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingNvidiaProvider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider: checkNvidiaProviderStatus(
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
              detail: `Failed to build NVIDIA snapshot: ${cause.message ?? String(cause)}`,
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
