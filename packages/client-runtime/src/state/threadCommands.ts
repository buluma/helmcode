import {
  type EnvironmentId,
  type ExecutionEnvironmentCapabilities,
  type ServerConfig,
} from "@helmcode/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";
import {
  type ArchiveThreadInput,
  type CancelThreadScheduleInput,
  type CreateThreadInput,
  type DeleteThreadInput,
  type InterruptThreadTurnInput,
  type RespondToThreadApprovalInput,
  type RespondToThreadUserInputInput,
  type RevertThreadCheckpointInput,
  type SetThreadInteractionModeInput,
  type SetThreadRuntimeModeInput,
  type ScheduleThreadInput,
  type PinThreadInput,
  type ReorderPinnedThreadInput,
  type SettleThreadInput,
  type SnoozeThreadInput,
  type StartThreadTurnInput,
  type StopThreadSessionInput,
  type UnarchiveThreadInput,
  type UnpinThreadInput,
  type UnsettleThreadInput,
  type UnsnoozeThreadInput,
  type UpdateThreadMetadataInput,
  archiveThread,
  cancelThreadSchedule,
  createThread,
  deleteThread,
  interruptThreadTurn,
  respondToThreadApproval,
  respondToThreadUserInput,
  revertThreadCheckpoint,
  setThreadInteractionMode,
  setThreadRuntimeMode,
  scheduleThread,
  pinThread,
  reorderPinnedThread,
  settleThread,
  snoozeThread,
  startThreadTurn,
  stopThreadSession,
  unarchiveThread,
  unpinThread,
  unsettleThread,
  unsnoozeThread,
  updateThreadMetadata,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type {
  ArchiveThreadInput,
  CancelThreadScheduleInput,
  CreateThreadInput,
  DeleteThreadInput,
  InterruptThreadTurnInput,
  RespondToThreadApprovalInput,
  RespondToThreadUserInputInput,
  RevertThreadCheckpointInput,
  SetThreadInteractionModeInput,
  SetThreadRuntimeModeInput,
  ScheduleThreadInput,
  PinThreadInput,
  ReorderPinnedThreadInput,
  SettleThreadInput,
  SnoozeThreadInput,
  StartThreadTurnInput,
  StopThreadSessionInput,
  UnarchiveThreadInput,
  UnpinThreadInput,
  UnsettleThreadInput,
  UnsnoozeThreadInput,
  UpdateThreadMetadataInput,
} from "../operations/commands.ts";

/**
 * Rejected when a command gated by a capability flag (see
 * `ExecutionEnvironmentCapabilities`) is sent to an environment whose server
 * config is known and does not advertise that capability. This is a backstop
 * against version skew: UI should already hide the affected action, but this
 * catches any caller that forgets to check, on any platform, before the RPC
 * ever leaves the client.
 */
export class ThreadCommandUnsupportedError extends Schema.TaggedErrorClass<ThreadCommandUnsupportedError>()(
  "ThreadCommandUnsupportedError",
  {
    environmentId: Schema.String,
    command: Schema.String,
    capability: Schema.String,
  },
) {}

export function createThreadEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
  configValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };
  // Guards a capability-gated command: reads the environment's last-known
  // server config out of the atom registry (no RPC of its own) and, only when
  // that config is present and explicitly lacks the capability, fails before
  // dispatching. A config we haven't loaded yet is not evidence of an
  // unsupported server, so it does not block the call.
  function requireCapability<Input, A, Err, Rx>(
    capability: keyof ExecutionEnvironmentCapabilities,
    command: string,
    execute: (input: Input) => Effect.Effect<A, Err, Rx>,
  ): (
    input: Input,
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
  ) => Effect.Effect<A, Err | ThreadCommandUnsupportedError, Rx> {
    return (input, registry, environmentId) => {
      const config = registry.get(configValueAtom(environmentId));
      if (config !== null && config.environment.capabilities[capability] !== true) {
        return Effect.fail(
          new ThreadCommandUnsupportedError({ environmentId, command, capability }),
        );
      }
      return execute(input);
    };
  }
  return {
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:create",
      execute: (input: CreateThreadInput) => createThread(input),
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:delete",
      execute: (input: DeleteThreadInput) => deleteThread(input),
      scheduler,
      concurrency,
    }),
    archive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:archive",
      execute: (input: ArchiveThreadInput) => archiveThread(input),
      scheduler,
      concurrency,
    }),
    unarchive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unarchive",
      execute: (input: UnarchiveThreadInput) => unarchiveThread(input),
      scheduler,
      concurrency,
    }),
    settle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:settle",
      execute: requireCapability("threadSettlement", "thread.settle", (input: SettleThreadInput) =>
        settleThread(input),
      ),
      scheduler,
      concurrency,
    }),
    unsettle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsettle",
      execute: requireCapability(
        "threadSettlement",
        "thread.unsettle",
        (input: UnsettleThreadInput) => unsettleThread(input),
      ),
      scheduler,
      concurrency,
    }),
    snooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:snooze",
      execute: requireCapability("threadSnooze", "thread.snooze", (input: SnoozeThreadInput) =>
        snoozeThread(input),
      ),
      scheduler,
      concurrency,
    }),
    unsnooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsnooze",
      execute: requireCapability("threadSnooze", "thread.unsnooze", (input: UnsnoozeThreadInput) =>
        unsnoozeThread(input),
      ),
      scheduler,
      concurrency,
    }),
    schedule: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:schedule",
      execute: requireCapability(
        "threadScheduling",
        "thread.schedule.create",
        (input: ScheduleThreadInput) => scheduleThread(input),
      ),
      scheduler,
      concurrency,
    }),
    cancelSchedule: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:cancel-schedule",
      execute: requireCapability(
        "threadScheduling",
        "thread.schedule.cancel",
        (input: CancelThreadScheduleInput) => cancelThreadSchedule(input),
      ),
      scheduler,
      concurrency,
    }),
    pin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:pin",
      execute: requireCapability("threadPinning", "thread.pin", (input: PinThreadInput) =>
        pinThread(input),
      ),
      scheduler,
      concurrency,
    }),
    unpin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unpin",
      execute: requireCapability("threadPinning", "thread.unpin", (input: UnpinThreadInput) =>
        unpinThread(input),
      ),
      scheduler,
      concurrency,
    }),
    reorderPin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-pin",
      execute: requireCapability(
        "threadPinReorder",
        "thread.pin.reorder",
        (input: ReorderPinnedThreadInput) => reorderPinnedThread(input),
      ),
      scheduler,
      concurrency,
    }),
    updateMetadata: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:update-metadata",
      execute: (input: UpdateThreadMetadataInput) => updateThreadMetadata(input),
      scheduler,
      concurrency,
    }),
    setRuntimeMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-runtime-mode",
      execute: (input: SetThreadRuntimeModeInput) => setThreadRuntimeMode(input),
      scheduler,
      concurrency,
    }),
    setInteractionMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-interaction-mode",
      execute: (input: SetThreadInteractionModeInput) => setThreadInteractionMode(input),
      scheduler,
      concurrency,
    }),
    startTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:start-turn",
      execute: (input: StartThreadTurnInput) => startThreadTurn(input),
      scheduler,
      concurrency,
    }),
    interruptTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:interrupt-turn",
      execute: (input: InterruptThreadTurnInput) => interruptThreadTurn(input),
      scheduler,
      concurrency,
    }),
    respondToApproval: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-approval",
      execute: (input: RespondToThreadApprovalInput) => respondToThreadApproval(input),
      scheduler,
      concurrency,
    }),
    respondToUserInput: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-user-input",
      execute: (input: RespondToThreadUserInputInput) => respondToThreadUserInput(input),
      scheduler,
      concurrency,
    }),
    revertCheckpoint: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:revert-checkpoint",
      execute: (input: RevertThreadCheckpointInput) => revertThreadCheckpoint(input),
      scheduler,
      concurrency,
    }),
    stopSession: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:stop-session",
      execute: (input: StopThreadSessionInput) => stopThreadSession(input),
      scheduler,
      concurrency,
    }),
  };
}
