import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@helmcode/client-runtime/state/runtime";
import type { ModelSelection, ScopedThreadRef, ThreadSchedule } from "@helmcode/contracts";
import { createModelSelection } from "@helmcode/shared/model";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { computeNextRunAt, PRESETS, type SchedulePreset } from "./ScheduleDialog.logic";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Textarea } from "./ui/textarea";
import { usePrimarySettings } from "../hooks/useSettings";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import { primaryServerProvidersAtom } from "../state/server";

interface ScheduleDialogProps {
  threadRef: ScopedThreadRef;
  open: boolean;
  onClose: () => void;
  onSave: (
    threadRef: ScopedThreadRef,
    schedule: ThreadSchedule,
  ) => Promise<AtomCommandResult<unknown, unknown>>;
}

type ScheduleMode = "interval" | "cron";

const DEFAULT_PROMPT = "Continue where you left off.";

export function ScheduleDialog({ threadRef, open, onClose, onSave }: ScheduleDialogProps) {
  const [mode, setMode] = useState<ScheduleMode>("interval");
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [cron, setCron] = useState("FREQ=DAILY;BYHOUR=9;BYMINUTE=0");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overrideModel, setOverrideModel] = useState(false);
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(null);

  const settings = usePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
      ),
    [serverProviders, settings],
  );
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, serverProviders),
    [serverProviders, settings],
  );
  const resolvedSelection = resolveDefaultProviderModelSelection(serverProviders, modelSelection);

  useEffect(() => {
    if (!open) return;
    setMode("interval");
    setIntervalMinutes(60);
    setCron("FREQ=DAILY;BYHOUR=9;BYMINUTE=0");
    setPrompt(DEFAULT_PROMPT);
    setError(null);
    setSaving(false);
    setOverrideModel(false);
    setModelSelection(null);
  }, [open]);

  const nextRunAt = useMemo(
    () => computeNextRunAt(mode, intervalMinutes, cron),
    [mode, intervalMinutes, cron],
  );

  const applyPreset = useCallback((preset: SchedulePreset) => {
    setMode(preset.mode);
    if (preset.intervalMinutes !== undefined) setIntervalMinutes(preset.intervalMinutes);
    if (preset.cron !== undefined) setCron(preset.cron);
  }, []);

  const handleSave = useCallback(async () => {
    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt.length === 0) {
      setError("Prompt cannot be empty.");
      return;
    }
    const schedule: ThreadSchedule = {
      enabled: true,
      cron: mode === "cron" ? cron : null,
      intervalMs: mode === "interval" ? Math.max(1, intervalMinutes) * 60_000 : null,
      prompt: trimmedPrompt,
      nextRunAt,
      createdAt: new Date().toISOString(),
      ...(overrideModel && resolvedSelection
        ? {
            modelSelection: createModelSelection(
              resolvedSelection.instanceId,
              resolvedSelection.model,
            ),
          }
        : {}),
    };
    setSaving(true);
    setError(null);
    try {
      const result = await onSave(threadRef, schedule);
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        throw squashAtomCommandFailure(result);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save schedule.");
    } finally {
      setSaving(false);
    }
  }, [
    cron,
    intervalMinutes,
    mode,
    nextRunAt,
    onClose,
    onSave,
    overrideModel,
    prompt,
    resolvedSelection,
    threadRef,
  ]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (nextOpen ? undefined : onClose())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Schedule this thread</DialogTitle>
          <DialogDescription>
            Automatically send a message and start a turn on this thread at a recurring interval.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="grid gap-1.5">
            <Label htmlFor="schedule-prompt">Prompt</Label>
            <Textarea
              id="schedule-prompt"
              rows={3}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Continue where you left off."
            />
          </div>

          <div className="flex flex-wrap gap-2">
            {PRESETS.map((preset) => (
              <Button
                key={preset.label}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => applyPreset(preset)}
              >
                {preset.label}
              </Button>
            ))}
          </div>

          <RadioGroup
            value={mode}
            onValueChange={(value) => setMode(value as ScheduleMode)}
            className="flex gap-4"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem id="schedule-interval" value="interval" />
              <Label htmlFor="schedule-interval">Interval</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id="schedule-cron" value="cron" />
              <Label htmlFor="schedule-cron">Cron</Label>
            </div>
          </RadioGroup>

          {mode === "interval" ? (
            <div className="grid gap-1.5">
              <Label htmlFor="schedule-interval-minutes">Every (minutes)</Label>
              <Input
                id="schedule-interval-minutes"
                type="number"
                min={1}
                value={intervalMinutes}
                onChange={(event) => setIntervalMinutes(Number(event.target.value) || 60)}
              />
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="schedule-cron-rule">RRULE</Label>
              <Input
                id="schedule-cron-rule"
                value={cron}
                onChange={(event) => setCron(event.target.value)}
                placeholder="FREQ=DAILY;BYHOUR=9;BYMINUTE=0"
              />
              <p className="text-xs text-muted-foreground">
                Supports FREQ=DAILY|WEEKLY|MONTHLY|HOURLY with optional BYHOUR/BYMINUTE/BYDAY.
              </p>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Next run: {new Date(nextRunAt).toLocaleString()}
          </p>

          <div className="flex items-center gap-2">
            <Checkbox
              id="schedule-override-model"
              checked={overrideModel}
              onCheckedChange={(checked) => setOverrideModel(Boolean(checked))}
            />
            <Label htmlFor="schedule-override-model">Override model for scheduled runs</Label>
          </div>
          {overrideModel && resolvedSelection ? (
            <ProviderModelPicker
              activeInstanceId={resolvedSelection.instanceId}
              model={resolvedSelection.model}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              triggerVariant="outline"
              onInstanceModelChange={(instanceId, model) =>
                setModelSelection(createModelSelection(instanceId, model))
              }
            />
          ) : null}

          {error ? <p className="text-destructive text-xs">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={() => void handleSave()} disabled={saving}>
            {saving ? "Saving..." : "Schedule"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
