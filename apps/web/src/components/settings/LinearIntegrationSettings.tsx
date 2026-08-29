import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@helmcode/client-runtime/state/runtime";
import type { EnvironmentId } from "@helmcode/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * Linear integration for one environment.
 *
 * The Linear API key lives on the selected environment's server (stored in its
 * secret store), so this section is scoped the same way provider settings are:
 * it reads the configured state from that server and writes the key back to it.
 */
export function LinearIntegrationSettings({
  environmentId,
  environmentLabel,
  readOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly readOnly?: boolean;
}) {
  const statusQuery = useAtomValue(serverEnvironment.getLinearApiKey({ environmentId, input: {} }));
  const setKey = useAtomCommand(serverEnvironment.setLinearApiKey, {
    reportFailure: false,
  });
  const removeKey = useAtomCommand(serverEnvironment.removeLinearApiKey, {
    reportFailure: false,
  });

  const [apiKey, setApiKey] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);

  const configured = Option.getOrNull(AsyncResult.value(statusQuery))?.configured ?? false;
  const isResolvingStatus = statusQuery.waiting;

  const refreshStatus = useCallback(() => {
    appAtomRegistry.refresh(serverEnvironment.getLinearApiKey({ environmentId, input: {} }));
  }, [environmentId]);

  const save = useCallback(async () => {
    const trimmed = apiKey.trim();
    if (trimmed.length === 0 || isSaving) {
      return;
    }
    setIsSaving(true);
    const result = await setKey({ environmentId, input: { apiKey: trimmed } });
    setIsSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not save Linear API key",
            description:
              error instanceof Error ? error.message : "The Linear API key could not be saved.",
          }),
        );
      }
      return;
    }
    setApiKey("");
    refreshStatus();
  }, [apiKey, isSaving, environmentId, setKey, refreshStatus]);

  const remove = useCallback(async () => {
    if (isRemoving) {
      return;
    }
    setIsRemoving(true);
    const result = await removeKey({ environmentId, input: {} });
    setIsRemoving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not remove Linear API key",
            description:
              error instanceof Error ? error.message : "The Linear API key could not be removed.",
          }),
        );
      }
      return;
    }
    refreshStatus();
  }, [isRemoving, environmentId, removeKey, refreshStatus]);

  const busy = isSaving || isRemoving || isResolvingStatus;

  return (
    <SettingsSection {...searchableSetting("integrations")}>
      <div
        inert={readOnly}
        aria-disabled={readOnly || undefined}
        className={readOnly ? "space-y-1 opacity-50 select-none" : "space-y-1"}
      >
        {readOnly ? (
          <SettingsRow
            title="Limited permissions"
            description={`This session can view ${environmentLabel}'s integrations, but its credential does not allow changing their configuration.`}
          />
        ) : null}
        <SettingsRow
          title="Linear"
          description="Connect Linear so agents can read, search, create, update, and comment on issues. Paste a personal API key; the key is stored on this environment's server and never leaves it."
          control={
            <div className="flex shrink-0 items-center gap-2">
              {configured ? (
                <span className="text-xs text-muted-foreground">Configured</span>
              ) : (
                <Input
                  type="password"
                  placeholder="lin_api_…"
                  aria-label="Linear API key"
                  autoComplete="off"
                  className="w-64"
                  value={apiKey}
                  disabled={readOnly || busy}
                  onChange={(event) => setApiKey(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void save();
                    }
                  }}
                />
              )}
              {configured ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={readOnly || busy}
                  onClick={() => void remove()}
                >
                  {isRemoving ? "Removing…" : "Remove"}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="default"
                  disabled={readOnly || busy || apiKey.trim().length === 0}
                  onClick={() => void save()}
                >
                  {isSaving ? "Saving…" : "Save"}
                </Button>
              )}
            </div>
          }
        />
      </div>
    </SettingsSection>
  );
}
