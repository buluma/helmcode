/**
 * Shared factory behind NvidiaAdapter.ts and OpenRouterAdapter.ts. Both
 * providers speak the exact same OpenAI-compatible chat-completions API,
 * offer the same read/list/search/write/run_command tool set with the same
 * approval-gating rules, and differ only in which HTTP endpoint they call --
 * every previous fix in this file used to have to land twice, byte-for-byte,
 * in two ~1500-line copies, which is exactly how the TCC/process-tree-kill
 * regression that shipped in one of them and not (yet) the other happened.
 * `providerKind`/`providerLabel` are the only per-provider knobs.
 *
 * @module provider/Layers/OpenAICompatibleWorkspaceAdapter
 */
import type {
  ProviderAdapterShape,
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";
import { PROVIDER_RUNTIME_EVENT_QUEUE_CAPACITY } from "../runtimeEventQueueCapacity.ts";

// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalTimersInEffect:off
// runShellCommand below manages a raw Node child_process's lifecycle
// (stdout/stderr listeners, a kill-on-timeout) outside of any Effect fiber,
// so there's no fiber-scoped Effect.sleep to use in its place.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  type CanonicalRequestType,
  EventId,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  ProviderRuntimeEvent,
  type RuntimeMode,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@helmcode/contracts";
import { isHostWindows } from "@helmcode/shared/hostProcess";
import {
  type ProviderAdapterError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";

const encodeJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const decodeJsonStringExit = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

interface ChatToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

/**
 * Narrows an API response's `tool_calls` field to well-formed entries only.
 * The API response is untyped JSON -- a model or a proxy in front of it can
 * return a tool_call missing `function`/`arguments`, and every downstream
 * consumer (the tool-call loop, argument summaries) assumes those fields
 * exist. A malformed entry is dropped rather than crashing the turn.
 */
function sanitizeToolCalls(value: unknown): Array<ChatToolCall> {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: Array<ChatToolCall> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const id = (entry as Record<string, unknown>).id;
    const fn = (entry as Record<string, unknown>).function;
    if (typeof id !== "string" || !fn || typeof fn !== "object") {
      continue;
    }
    const name = (fn as Record<string, unknown>).name;
    const args = (fn as Record<string, unknown>).arguments;
    if (typeof name !== "string" || typeof args !== "string") {
      continue;
    }
    result.push({ id, type: "function", function: { name, arguments: args } });
  }
  return result;
}

/**
 * OpenAI-compatible chat message shapes. `assistant` carries `tool_calls`
 * when the model wants a tool run instead of answering; `tool` carries the
 * result back, keyed by `tool_call_id` to the call it answers.
 */
type ChatMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly tool_calls?: ReadonlyArray<ChatToolCall>;
    }
  | { readonly role: "tool"; readonly content: string; readonly tool_call_id: string };

interface Session {
  readonly cwd: string | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly messages: Array<ChatMessage>;
  /**
   * Raw-message count appended per turn, in order, so readThread/rollbackThread
   * can find turn boundaries -- a turn with tool calls appends more than the
   * fixed 2 messages (user + assistant) a plain text turn does.
   */
  readonly turnMessageCounts: Array<number>;
  /**
   * Request types the user granted "acceptForSession" for -- once a decision
   * comes back with that verdict, every later request of the same type in
   * this session auto-accepts instead of asking again.
   */
  readonly autoAcceptedRequestTypes: Set<CanonicalRequestType>;
}

interface PendingApproval {
  readonly threadId: ThreadId;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

// write_file and run_command are gated by requestApprovalIfNeeded below,
// same shape as ClaudeAdapter's canUseTool: allowed outright in full-access
// sessions, file changes auto-allowed in auto-accept-edits, everything else
// asks via request.opened/request.resolved and respondToRequest.
// respondToUserInput (structured question-answering) has no equivalent
// here and stays unsupported.
const WORKSPACE_TOOL_MAX_FILE_BYTES = 256 * 1024;
const WORKSPACE_TOOL_MAX_ENTRIES = 500;
const WORKSPACE_TOOL_MAX_MATCHES = 200;
// Bounds the directory walk itself (files + directories visited), separate
// from WORKSPACE_TOOL_MAX_ENTRIES/MAX_MATCHES, which only cap what gets
// returned after the walk. Without this, listing or searching a huge tree
// (or one where an excluded directory wasn't actually excluded) did
// unbounded work before ever applying those caps.
const WORKSPACE_TOOL_MAX_SCAN_ENTRIES = 2000;
const WORKSPACE_TOOL_EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
]);

const WORKSPACE_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file's contents, given a path relative to the project root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the project root." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List entries in a directory relative to the project root.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path relative to the project root. Defaults to the root.",
          },
          recursive: {
            type: "boolean",
            description: "List nested directories too. Defaults to false.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_text",
      description:
        "Search for a substring (case-insensitive) across text files under a directory relative to the project root.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to search for." },
          path: {
            type: "string",
            description:
              "Directory to search under, relative to the project root. Defaults to the root.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a text file, given a path relative to the project root. Requires the user's approval unless the session has full access or has already accepted file changes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the project root." },
          content: { type: "string", description: "Full contents to write to the file." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command in the project root and return its stdout/stderr/exit code. Requires the user's approval unless the session has full access or has already accepted command execution.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run." },
        },
        required: ["command"],
      },
    },
  },
] as const;

/**
 * Resolves a model-supplied path against `cwd`, rejecting anything that
 * escapes it. Accepts an absolute path too -- models routinely echo back the
 * cwd they were told about instead of a relative path, and treating that as
 * relative-to-root (the old behavior) re-rooted it into nonsense like
 * `<root>/Users/you/project`. An absolute path is resolved as-is and still
 * has to land inside `cwd`; it isn't exempt from either containment check
 * below. Two layers: a lexical normalize-then-startsWith check (mirrors
 * resolveAttachmentRelativePath in attachmentPaths.ts) rejects `..` traversal
 * outright, then an fs.realPath containment check on whatever survives
 * catches a symlink that resolves outside `cwd` without ever appearing to
 * escape it lexically. Missing paths (ENOENT) are not an escape -- callers
 * surface those as their own tool-result error.
 */
const resolveWorkspacePath = (
  fs: FileSystem.FileSystem,
  cwd: string,
  relativePath: string,
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    if (relativePath.includes("\0")) {
      return null;
    }
    const root = NodePath.resolve(cwd);
    const lexicallyResolved = NodePath.isAbsolute(relativePath)
      ? NodePath.resolve(relativePath)
      : NodePath.resolve(NodePath.join(root, NodePath.normalize(relativePath || ".")));
    if (lexicallyResolved !== root && !lexicallyResolved.startsWith(`${root}${NodePath.sep}`)) {
      return null;
    }

    const realRoot = yield* fs.realPath(root).pipe(Effect.result);
    const realTarget = yield* fs.realPath(lexicallyResolved).pipe(Effect.result);
    // A target that doesn't exist yet can't have a real path to compare --
    // fall through to the caller's own not-found handling instead of
    // treating a missing file as an escape attempt.
    if (realTarget._tag === "Failure" || realRoot._tag === "Failure") {
      return lexicallyResolved;
    }
    if (
      realTarget.success !== realRoot.success &&
      !realTarget.success.startsWith(`${realRoot.success}${NodePath.sep}`)
    ) {
      return null;
    }
    return lexicallyResolved;
  });

function isExcludedWorkspaceSegment(segment: string): boolean {
  return WORKSPACE_TOOL_EXCLUDED_DIR_NAMES.has(segment);
}

interface WorkspaceWalkEntry {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly type: FileSystem.File.Info["type"];
}

/**
 * Breadth-first walk of `root`, bounded and symlink-safe. Two things a plain
 * `fs.readDirectory(root, { recursive: true })` doesn't give us:
 *
 * - Excluded directories (node_modules, .git, ...) are skipped before ever
 *   descending into them, not filtered out of the full listing afterward --
 *   the earlier version walked the whole excluded subtree first and threw
 *   the result away.
 * - Every entry's realpath is checked against `realRoot` before it's
 *   trusted, so a symlink anywhere in the tree that points outside `root`
 *   (not just at `root` itself) can't be read through.
 *
 * Stops after `maxEntries` regardless of how much of the tree remains, so a
 * huge or pathological directory can't turn one tool call into an unbounded
 * scan.
 */
const walkWorkspaceEntries = (
  fs: FileSystem.FileSystem,
  root: string,
  realRoot: string,
  options: { readonly recursive: boolean; readonly maxEntries: number },
): Effect.Effect<{
  readonly entries: ReadonlyArray<WorkspaceWalkEntry>;
  readonly truncated: boolean;
}> =>
  Effect.gen(function* () {
    const results: Array<WorkspaceWalkEntry> = [];
    const queue: Array<string> = [""];
    let truncated = false;

    while (queue.length > 0) {
      const relDir = queue.shift()!;
      const dirPath = relDir.length > 0 ? NodePath.join(root, relDir) : root;
      const names = yield* fs.readDirectory(dirPath).pipe(Effect.result);
      if (names._tag === "Failure") {
        continue;
      }

      for (const name of names.success) {
        if (results.length >= options.maxEntries) {
          truncated = true;
          break;
        }
        if (isExcludedWorkspaceSegment(name)) {
          continue;
        }

        const relativePath = relDir.length > 0 ? `${relDir}/${name}` : name;
        const absolutePath = NodePath.join(root, relativePath);

        const real = yield* fs.realPath(absolutePath).pipe(Effect.result);
        if (real._tag === "Failure") {
          continue;
        }
        if (real.success !== realRoot && !real.success.startsWith(`${realRoot}${NodePath.sep}`)) {
          continue;
        }

        const stat = yield* fs.stat(absolutePath).pipe(Effect.result);
        if (stat._tag === "Failure") {
          continue;
        }

        results.push({ relativePath, absolutePath, type: stat.success.type });
        if (options.recursive && stat.success.type === "Directory") {
          queue.push(relativePath);
        }
      }

      if (truncated) {
        break;
      }
    }

    return { entries: results, truncated };
  });

const readWorkspaceFileTool = (
  fs: FileSystem.FileSystem,
  cwd: string,
  args: { readonly path?: unknown },
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const rawPath = typeof args.path === "string" ? args.path : undefined;
    if (!rawPath) {
      return "Error: 'path' is required.";
    }
    const resolved = yield* resolveWorkspacePath(fs, cwd, rawPath);
    if (!resolved) {
      return `Error: path '${rawPath}' is outside the project root.`;
    }
    const stat = yield* fs.stat(resolved).pipe(Effect.result);
    if (stat._tag === "Failure") {
      return `Error: could not stat '${rawPath}': ${stat.failure.message}`;
    }
    if (stat.success.type !== "File") {
      return `Error: '${rawPath}' is not a regular file.`;
    }
    const content = yield* fs.readFileString(resolved).pipe(Effect.result);
    if (content._tag === "Failure") {
      return `Error: could not read '${rawPath}': ${content.failure.message}`;
    }
    const bytes = Buffer.byteLength(content.success, "utf8");
    if (bytes <= WORKSPACE_TOOL_MAX_FILE_BYTES) {
      return content.success;
    }
    const truncated = Buffer.from(content.success, "utf8")
      .subarray(0, WORKSPACE_TOOL_MAX_FILE_BYTES)
      .toString("utf8");
    return `${truncated}\n... (truncated at ${WORKSPACE_TOOL_MAX_FILE_BYTES} bytes)`;
  });

/**
 * Resolves `resolved` to its realpath for use as the walk's containment
 * root. Distinct from resolveWorkspacePath's own realpath check (which only
 * verifies `resolved` itself doesn't escape `cwd`) -- this is the value
 * every entry found during the walk gets compared against.
 */
const realWorkspaceRoot = (
  fs: FileSystem.FileSystem,
  resolved: string,
): Effect.Effect<string | null> =>
  fs.realPath(resolved).pipe(
    Effect.result,
    Effect.map((result) => (result._tag === "Success" ? result.success : null)),
  );

const listWorkspaceDirectoryTool = (
  fs: FileSystem.FileSystem,
  cwd: string,
  args: { readonly path?: unknown; readonly recursive?: unknown },
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const rawPath = typeof args.path === "string" ? args.path : ".";
    const recursive = args.recursive === true;
    const resolved = yield* resolveWorkspacePath(fs, cwd, rawPath);
    if (!resolved) {
      return `Error: path '${rawPath}' is outside the project root.`;
    }
    const realRoot = yield* realWorkspaceRoot(fs, resolved);
    if (!realRoot) {
      return `Error: could not resolve '${rawPath}'.`;
    }

    const { entries, truncated } = yield* walkWorkspaceEntries(fs, resolved, realRoot, {
      recursive,
      maxEntries: Math.min(WORKSPACE_TOOL_MAX_ENTRIES, WORKSPACE_TOOL_MAX_SCAN_ENTRIES),
    });
    const listing =
      entries.length > 0 ? entries.map((entry) => entry.relativePath).join("\n") : "(empty)";
    return truncated
      ? `${listing}\n... (truncated at ${WORKSPACE_TOOL_MAX_ENTRIES} entries)`
      : listing;
  });

const searchWorkspaceTextTool = (
  fs: FileSystem.FileSystem,
  cwd: string,
  args: { readonly query?: unknown; readonly path?: unknown },
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const query = typeof args.query === "string" ? args.query : undefined;
    if (!query) {
      return "Error: 'query' is required.";
    }
    const rawPath = typeof args.path === "string" ? args.path : ".";
    const root = yield* resolveWorkspacePath(fs, cwd, rawPath);
    if (!root) {
      return `Error: path '${rawPath}' is outside the project root.`;
    }
    const realRoot = yield* realWorkspaceRoot(fs, root);
    if (!realRoot) {
      return `Error: could not resolve '${rawPath}'.`;
    }

    const { entries, truncated: scanTruncated } = yield* walkWorkspaceEntries(fs, root, realRoot, {
      recursive: true,
      maxEntries: WORKSPACE_TOOL_MAX_SCAN_ENTRIES,
    });

    const needle = query.toLowerCase();
    const matches: Array<string> = [];
    for (const entry of entries) {
      if (matches.length >= WORKSPACE_TOOL_MAX_MATCHES) {
        break;
      }
      if (entry.type !== "File") {
        continue;
      }
      const stat = yield* fs.stat(entry.absolutePath).pipe(Effect.result);
      if (stat._tag === "Failure" || stat.success.size > BigInt(WORKSPACE_TOOL_MAX_FILE_BYTES)) {
        continue;
      }
      const content = yield* fs.readFileString(entry.absolutePath).pipe(Effect.result);
      if (content._tag === "Failure") {
        continue;
      }
      // Binary files decode as text containing the replacement character or
      // NUL bytes on a mismatched encoding; skip rather than spam matches.
      if (content.success.includes("\0")) {
        continue;
      }
      const lines = content.success.split("\n");
      for (let i = 0; i < lines.length && matches.length < WORKSPACE_TOOL_MAX_MATCHES; i++) {
        if (lines[i]!.toLowerCase().includes(needle)) {
          matches.push(`${entry.relativePath}:${i + 1}: ${lines[i]!.trim().slice(0, 300)}`);
        }
      }
    }

    const scanNote = scanTruncated
      ? `\n... (scan stopped at ${WORKSPACE_TOOL_MAX_SCAN_ENTRIES} files/directories -- results may be incomplete)`
      : "";

    if (matches.length === 0) {
      return `No matches found.${scanNote}`;
    }
    return matches.length >= WORKSPACE_TOOL_MAX_MATCHES
      ? `${matches.join("\n")}\n... (truncated at ${WORKSPACE_TOOL_MAX_MATCHES} matches)${scanNote}`
      : `${matches.join("\n")}${scanNote}`;
  });

const writeWorkspaceFileTool = (
  fs: FileSystem.FileSystem,
  cwd: string,
  args: { readonly path?: unknown; readonly content?: unknown },
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const rawPath = typeof args.path === "string" ? args.path : undefined;
    const content = typeof args.content === "string" ? args.content : undefined;
    if (!rawPath) {
      return "Error: 'path' is required.";
    }
    if (content === undefined) {
      return "Error: 'content' is required.";
    }
    const resolved = yield* resolveWorkspacePath(fs, cwd, rawPath);
    if (!resolved) {
      return `Error: path '${rawPath}' is outside the project root.`;
    }
    yield* fs.makeDirectory(NodePath.dirname(resolved), { recursive: true }).pipe(Effect.result);
    // resolveWorkspacePath can't realpath-check a target that doesn't exist
    // yet, so a symlinked directory inside the workspace would otherwise let
    // this write land anywhere on disk. Re-check the now-existing parent.
    const root = NodePath.resolve(cwd);
    const realRoot = yield* fs.realPath(root).pipe(Effect.result);
    const realParent = yield* fs.realPath(NodePath.dirname(resolved)).pipe(Effect.result);
    if (
      realRoot._tag === "Failure" ||
      realParent._tag === "Failure" ||
      (realParent.success !== realRoot.success &&
        !realParent.success.startsWith(`${realRoot.success}${NodePath.sep}`))
    ) {
      return `Error: path '${rawPath}' is outside the project root.`;
    }
    const written = yield* fs.writeFileString(resolved, content).pipe(Effect.result);
    if (written._tag === "Failure") {
      return `Error: could not write '${rawPath}': ${written.failure.message}`;
    }
    return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to '${rawPath}'.`;
  });

const WORKSPACE_COMMAND_TIMEOUT_MS = 60_000;
const WORKSPACE_COMMAND_MAX_OUTPUT_BYTES = 256 * 1024;

interface WorkspaceCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly timedOut: boolean;
}

/**
 * Lists `pid`'s direct children via `pgrep -P`, recursively, to build the
 * full descendant set. `pgrep` exits 1 (not an error, just "no children")
 * when a process has none.
 */
function collectDescendantPids(pid: number): ReadonlyArray<number> {
  try {
    const output = NodeChildProcess.execFileSync("pgrep", ["-P", String(pid)], {
      encoding: "utf8",
    });
    const children = output
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    return children.flatMap((child) => [child, ...collectDescendantPids(child)]);
  } catch {
    return [];
  }
}

/**
 * Kills `pid` and everything it spawned, not just the shell itself -- a
 * plain `child.kill()` only signals the shell process, so a command like
 * `sleep 30 &` leaves its background descendant running past timeout or
 * interruption. Windows: `taskkill /T` walks the process tree directly.
 * POSIX: deliberately NOT `spawn(..., { detached: true })` + a process-group
 * kill -- `detached` makes the shell its own session leader (setsid), and on
 * macOS that breaks the TCC/file-access grant the spawned shell would
 * otherwise inherit from this app, turning every workspace-relative command
 * into "Operation not permitted" (observed in production). `pgrep`-based
 * descendant discovery gets the same result without touching the process's
 * session.
 */
function killProcessTree(pid: number, isWindows: boolean): void {
  if (isWindows) {
    NodeChildProcess.spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  for (const target of [pid, ...collectDescendantPids(pid)]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // Already gone (e.g. exited on its own between the close/error event
      // and this cleanup running).
    }
  }
}

/**
 * Runs `command` through the platform shell in `cwd`. Deliberately not
 * routed through this codebase's ProcessRunner service -- that would widen
 * every driver/test wiring for these adapters just to reach it, for a
 * capability (arbitrary shell exec) that's already gated behind an approval
 * decision before this ever runs. Output is capped and the process is
 * killed on timeout so one runaway command can't hang or flood a turn.
 */
const runShellCommand = (
  cwd: string,
  command: string,
  isWindows: boolean,
): Effect.Effect<WorkspaceCommandResult> =>
  Effect.callback<WorkspaceCommandResult>((resume) => {
    const child = NodeChildProcess.spawn(
      isWindows ? "cmd.exe" : "/bin/sh",
      isWindows ? ["/d", "/s", "/c", command] : ["-c", command],
      { cwd, windowsHide: true },
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const killTree = (): void => {
      if (typeof child.pid === "number") {
        killProcessTree(child.pid, isWindows);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, WORKSPACE_COMMAND_TIMEOUT_MS);

    const append = (current: string, chunk: Buffer): string =>
      current.length >= WORKSPACE_COMMAND_MAX_OUTPUT_BYTES
        ? current
        : current + chunk.toString("utf8");

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resume(
        Effect.succeed({ stdout, stderr: `${stderr}\n${error.message}`, code: null, timedOut }),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resume(Effect.succeed({ stdout, stderr, code, timedOut }));
    });

    return Effect.sync(() => {
      clearTimeout(timer);
      killTree();
    });
  });

const runWorkspaceCommandTool = (
  cwd: string,
  args: { readonly command?: unknown },
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const command = typeof args.command === "string" ? args.command.trim() : undefined;
    if (!command) {
      return "Error: 'command' is required.";
    }

    const isWindows = yield* isHostWindows;
    const result = yield* runShellCommand(cwd, command, isWindows);
    const cap = (text: string): string =>
      text.length > WORKSPACE_COMMAND_MAX_OUTPUT_BYTES
        ? `${text.slice(0, WORKSPACE_COMMAND_MAX_OUTPUT_BYTES)}\n... (truncated)`
        : text;
    const stdout = cap(result.stdout);
    const stderr = cap(result.stderr);

    if (result.timedOut) {
      return `Error: command timed out after ${WORKSPACE_COMMAND_TIMEOUT_MS}ms.\nstdout:\n${stdout || "(empty)"}\nstderr:\n${stderr || "(empty)"}`;
    }
    return `exit code: ${result.code ?? "unknown"}\nstdout:\n${stdout || "(empty)"}\nstderr:\n${stderr || "(empty)"}`;
  });

/**
 * Tools that mutate the workspace or run arbitrary commands, mapped to the
 * canonical approval type they require. Reads (read_file, list_directory,
 * search_text) aren't in this map -- they never need approval, in
 * "full-access" or otherwise, same as every other adapter in this codebase.
 */
const WORKSPACE_APPROVAL_REQUIRED_TOOLS = new Map<string, CanonicalRequestType>([
  ["write_file", "file_change_approval"],
  ["run_command", "command_execution_approval"],
]);

/**
 * Dispatches one model tool call to its implementation. Never fails: a
 * malformed arguments payload or an unknown tool name becomes an error
 * string in the tool result, the same way a bad path does, so the model can
 * see what went wrong and retry instead of the whole turn dying.
 */
const runWorkspaceTool = (
  fs: FileSystem.FileSystem,
  cwd: string,
  toolCall: ChatToolCall,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const parsed = decodeJsonStringExit(toolCall.function.arguments);
    const args = (parsed._tag === "Success" ? parsed.value : {}) as Record<string, unknown>;
    if (parsed._tag === "Failure") {
      return `Error: could not parse arguments for '${toolCall.function.name}'.`;
    }

    switch (toolCall.function.name) {
      case "read_file":
        return yield* readWorkspaceFileTool(fs, cwd, args);
      case "list_directory":
        return yield* listWorkspaceDirectoryTool(fs, cwd, args);
      case "search_text":
        return yield* searchWorkspaceTextTool(fs, cwd, args);
      case "write_file":
        return yield* writeWorkspaceFileTool(fs, cwd, args);
      case "run_command":
        return yield* runWorkspaceCommandTool(cwd, args);
      default:
        return `Error: unknown tool '${toolCall.function.name}'.`;
    }
  });

// This adapter has the same tool set as Claude/Codex -- read/list/search,
// write, and run_command -- but write_file and run_command need the user's
// approval unless the session is full-access or already accepted that
// request type. The model should attempt them anyway; a decline comes back
// as a tool result it can react to, same as any other tool error.
function systemMessageFor(cwd: string | undefined): { role: "system"; content: string } {
  return {
    role: "system",
    content: cwd
      ? `You are assisting with the project checked out at ${cwd}. You have tools to read files, list directories, search text, write files, and run shell commands under this path. Writing files and running commands may require the user's approval first. Use the tools before answering questions about the code.`
      : "You have no file, shell, or tool access -- you cannot read or list any codebase. If the user asks about code, ask them to paste it.",
  };
}

/**
 * Builds a `makeXAdapter` for one OpenAI-compatible chat-completions
 * gateway. `providerKind` tags every emitted event/error; `providerLabel` is
 * the human-readable name that shows up in error text and log messages
 * (e.g. "NVIDIA", "OpenRouter").
 */
export function makeOpenAICompatibleWorkspaceAdapter(providerConfig: {
  readonly providerKind: ProviderDriverKind;
  readonly providerLabel: string;
}) {
  const PROVIDER = providerConfig.providerKind;
  const LABEL = providerConfig.providerLabel;

  /**
   * This gateway occasionally 500s on transient plumbing (observed on
   * NVIDIA's: "Missing request extension ... axum::Extension") and clears up
   * seconds later. Marks a response as worth retrying; never thrown for 4xx
   * (bad key/model/quota), which are not transient, except 429 -- a rate
   * limit clears up on its own the same way a 5xx does, and failing the
   * whole session on the first 429 (as observed in production logs)
   * needlessly kills a turn that would have gone through moments later.
   */
  class TransientHttpError extends Schema.TaggedErrorClass<TransientHttpError>()(
    "OpenAICompatibleTransientHttpError",
    { status: Schema.Number, detail: Schema.String },
  ) {
    override get message(): string {
      return this.detail;
    }
  }

  /**
   * Signals a 400 that only showed up because `tools` was sent -- there's no
   * reliable up-front list of which models available through this gateway
   * support function calling, so this drives one fallback retry without
   * tools instead of failing turns against models that don't.
   */
  class ToolsUnsupportedError extends Schema.TaggedErrorClass<ToolsUnsupportedError>()(
    "OpenAICompatibleToolsUnsupportedError",
    { detail: Schema.String },
  ) {
    override get message(): string {
      return this.detail;
    }
  }

  const isTransientHttpError = Schema.is(TransientHttpError);
  const isToolsUnsupportedError = Schema.is(ToolsUnsupportedError);

  interface ChatCompletionResult {
    readonly content: string | null;
    readonly toolCalls: ReadonlyArray<ChatToolCall>;
  }

  // Retried request never touched session state or produced any content, so
  // re-issuing it duplicates nothing -- unlike a turn already visible to the
  // user or the workspace.
  const HTTP_RETRY_SCHEDULE = Schedule.exponential("500 millis").pipe(Schedule.upTo({ times: 3 }));

  // Caps total round-trips per turn -- cheap to raise later, exists purely
  // to bound cost/latency against a model that keeps calling tools instead
  // of answering. The caller's own attempt is round 1; there's no vendor
  // doc recommendation for this number, so it's a starting guess.
  const TOOL_LOOP_MAX_ROUNDS = 25;

  return Effect.fn(`make${LABEL.replace(/[^a-zA-Z0-9]/g, "")}Adapter`)(function* (input: {
    readonly apiKey: string;
    readonly baseUrl: string;
    readonly defaultModel: string;
  }) {
    const sessions = new Map<ThreadId, Session>();
    const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
    // The detached fiber sendTurn forks to run a turn in the background --
    // tracked so interruptTurn/stopSession/stopAll can actually stop it,
    // instead of only clearing bookkeeping while the HTTP call and tool loop
    // keep running and eventually resurrect the session they were told to
    // tear down.
    const runningTurnFibers = new Map<ThreadId, Fiber.Fiber<void, ProviderAdapterRequestError>>();

    const events = yield* PubSub.bounded<ProviderRuntimeEvent>(
      PROVIDER_RUNTIME_EVENT_QUEUE_CAPACITY,
    );

    const publish = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Effect.ignoreCause(PubSub.publish(events, event));

    const crypto = yield* Crypto.Crypto;
    const httpClient = yield* HttpClient.HttpClient;
    const fs = yield* FileSystem.FileSystem;

    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: `Failed to generate ${LABEL} runtime identifier.`,
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, EventId.make);
    const nextTurnId = Effect.map(randomUUIDv4, TurnId.make);
    const nextRequestId = Effect.map(randomUUIDv4, ApprovalRequestId.make);
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

    /**
     * Gates a write_file/run_command tool call behind the session's runtime
     * mode, mirroring ClaudeAdapter's canUseTool: "full-access" auto-allows
     * everything, "auto-accept-edits" auto-allows file changes but still asks
     * for commands, and every other mode asks for both -- unless the user
     * already granted "acceptForSession" for this request type earlier in the
     * session, in which case it's remembered and skipped.
     */
    const requestApprovalIfNeeded = (approvalInput: {
      readonly session: Session;
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly requestType: CanonicalRequestType;
      readonly detail: string;
    }): Effect.Effect<ProviderApprovalDecision, ProviderAdapterRequestError> =>
      Effect.gen(function* () {
        if (
          approvalInput.session.runtimeMode === "full-access" ||
          (approvalInput.session.runtimeMode === "auto-accept-edits" &&
            approvalInput.requestType === "file_change_approval") ||
          approvalInput.session.autoAcceptedRequestTypes.has(approvalInput.requestType)
        ) {
          return "accept" as const;
        }

        const requestId = yield* nextRequestId;
        const decision = yield* Deferred.make<ProviderApprovalDecision>();
        pendingApprovals.set(requestId, { threadId: approvalInput.threadId, decision });

        yield* publish({
          eventId: yield* nextEventId,
          provider: PROVIDER,
          threadId: approvalInput.threadId,
          turnId: approvalInput.turnId,
          requestId: RuntimeRequestId.make(requestId),
          createdAt: yield* nowIso,
          type: "request.opened",
          payload: { requestType: approvalInput.requestType, detail: approvalInput.detail },
        });

        const resolved = yield* Deferred.await(decision);
        pendingApprovals.delete(requestId);

        if (resolved === "acceptForSession") {
          approvalInput.session.autoAcceptedRequestTypes.add(approvalInput.requestType);
        }

        yield* publish({
          eventId: yield* nextEventId,
          provider: PROVIDER,
          threadId: approvalInput.threadId,
          turnId: approvalInput.turnId,
          requestId: RuntimeRequestId.make(requestId),
          createdAt: yield* nowIso,
          type: "request.resolved",
          payload: { requestType: approvalInput.requestType, decision: resolved },
        });

        return resolved;
      });

    const attemptChatCompletions = (payload: {
      readonly messages: ReadonlyArray<ChatMessage>;
      readonly model: string;
      readonly tools?: typeof WORKSPACE_TOOLS | undefined;
    }): Effect.Effect<
      ChatCompletionResult,
      ProviderAdapterRequestError | TransientHttpError | ToolsUnsupportedError
    > =>
      Effect.gen(function* () {
        const bodyEncoded = encodeJsonStringExit({
          model: payload.model,
          messages: payload.messages,
          temperature: 0.2,
          ...(payload.tools ? { tools: payload.tools, tool_choice: "auto" } : {}),
        });
        const bodyText =
          bodyEncoded._tag === "Failure"
            ? yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "chat.completions",
                detail: "Failed to encode request body.",
                cause: bodyEncoded.cause,
              })
            : bodyEncoded.value;

        const request = HttpClientRequest.post(
          `${input.baseUrl.replace(/\/$/, "")}/chat/completions`,
        ).pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${input.apiKey}`),
          // bodyText's own contentType arg is authoritative -- HttpBody.text
          // defaults to "text/plain" and overwrites whatever setHeader set
          // before it, which was silently clobbering this to text/plain and
          // getting every request rejected with a 415 by the upstream API.
          HttpClientRequest.bodyText(bodyText, "application/json"),
        );

        // A gateway that never answers (no error, no response) would
        // otherwise hang this turn's fiber forever -- bounded here so a dead
        // upstream surfaces as a retryable transient failure instead.
        const responseText = yield* Effect.gen(function* () {
          const response = yield* httpClient.execute(request).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "chat.completions",
                  detail: `Failed to reach ${LABEL}.`,
                  cause,
                }),
            ),
          );

          if (response.status !== 200) {
            const text = yield* response.text.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "chat.completions",
                    detail: `Failed to read error response body: ${cause}`,
                    cause,
                  }),
              ),
            );
            const detail = `HTTP ${response.status}: ${text.trim().length > 0 ? text.trim() : String(response.status)}`;
            if (response.status >= 500 || response.status === 429) {
              return yield* new TransientHttpError({ status: response.status, detail });
            }
            // Not every model available through this gateway supports
            // function calling, and there's no reliable capability list to
            // check up front -- a 400 that only shows up when `tools` was
            // sent is the signal to retry once without it rather than fail
            // the whole turn.
            if (payload.tools && response.status === 400) {
              return yield* new ToolsUnsupportedError({ detail });
            }
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "chat.completions",
              detail,
              cause: new Error(`HTTP ${response.status}`),
            });
          }

          return yield* response.text.pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "chat.completions",
                  detail: `Failed to read response body: ${cause}`,
                  cause,
                }),
            ),
          );
        }).pipe(
          Effect.timeout("120 seconds"),
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(
              new TransientHttpError({
                status: 504,
                detail: `${LABEL} did not respond within 120 seconds.`,
              }),
            ),
          ),
        );

        const parsed = yield* Effect.try({
          try: () => {
            const result = decodeJsonStringExit(responseText);
            if (result._tag === "Failure") throw result.cause;
            return result.value as Record<string, unknown>;
          },
          catch: (error) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "chat.completions",
              detail: `${LABEL} response body was not valid JSON.`,
              cause: error,
            }),
        });

        const choices = (parsed.choices as Array<Record<string, unknown>> | undefined) ?? [];
        const message = choices[0]?.message as Record<string, unknown> | undefined;
        const content = typeof message?.content === "string" ? message.content : null;
        const toolCalls = sanitizeToolCalls(message?.tool_calls);
        if ((!content || content.trim().length === 0) && toolCalls.length === 0) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "chat.completions",
            detail: "Model returned an empty response.",
          });
        }

        return { content, toolCalls };
      });

    const retryTransient = <A>(
      effect: Effect.Effect<
        A,
        ProviderAdapterRequestError | TransientHttpError | ToolsUnsupportedError
      >,
    ) =>
      effect.pipe(
        Effect.retry({
          while: (error) => isTransientHttpError(error),
          schedule: HTTP_RETRY_SCHEDULE,
        }),
      );

    const toRequestError = (
      error: ProviderAdapterRequestError | TransientHttpError | ToolsUnsupportedError,
    ): ProviderAdapterRequestError =>
      isTransientHttpError(error) || isToolsUnsupportedError(error)
        ? new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "chat.completions",
            detail: error.message,
            cause: error,
          })
        : error;

    const callChatCompletions = (payload: {
      readonly messages: ReadonlyArray<ChatMessage>;
      readonly model: string;
      readonly tools?: typeof WORKSPACE_TOOLS | undefined;
    }): Effect.Effect<ChatCompletionResult, ProviderAdapterRequestError> =>
      retryTransient(attemptChatCompletions(payload)).pipe(
        Effect.catch((error) => {
          // One fallback attempt without tools when the model/deployment
          // rejected the tools field outright -- see ToolsUnsupportedError.
          if (isToolsUnsupportedError(error) && payload.tools) {
            return retryTransient(attemptChatCompletions({ ...payload, tools: undefined })).pipe(
              Effect.catch((fallbackError) => Effect.fail(toRequestError(fallbackError))),
            );
          }
          return Effect.fail(toRequestError(error));
        }),
      );

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (
      sessionInput,
    ) =>
      Effect.gen(function* () {
        sessions.set(sessionInput.threadId, {
          cwd: sessionInput.cwd,
          runtimeMode: sessionInput.runtimeMode,
          messages: [],
          turnMessageCounts: [],
          autoAcceptedRequestTypes: new Set(),
        });

        yield* publish({
          eventId: yield* nextEventId,
          provider: PROVIDER,
          threadId: sessionInput.threadId,
          createdAt: yield* nowIso,
          type: "session.started",
          payload: { message: sessionInput.cwd ?? undefined },
        });

        return {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: sessionInput.runtimeMode,
          cwd: sessionInput.cwd,
          threadId: sessionInput.threadId,
          createdAt: yield* nowIso,
          updatedAt: yield* nowIso,
        };
      });

    /**
     * Drives the tool-call round-trip for one turn: calls chat/completions,
     * and for as long as the model asks for tool calls instead of answering,
     * executes them locally and feeds the results back. Returns every raw
     * message the loop appended (tool_calls, tool results, final answer) so
     * the caller can both persist them into session history and know the
     * user-facing text. Tools are omitted entirely when `cwd` is unknown --
     * there's nothing to sandbox them to.
     */
    const runToolLoop = (loopInput: {
      readonly session: Session;
      readonly model: string;
      readonly history: ReadonlyArray<ChatMessage>;
      readonly userMessage: ChatMessage;
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
    }): Effect.Effect<
      { readonly appendedMessages: ReadonlyArray<ChatMessage>; readonly finalText: string },
      ProviderAdapterRequestError
    > =>
      Effect.gen(function* () {
        const appended: Array<ChatMessage> = [loopInput.userMessage];
        const cwd = loopInput.session.cwd;

        for (let round = 0; round < TOOL_LOOP_MAX_ROUNDS; round++) {
          const result = yield* callChatCompletions({
            messages: [systemMessageFor(cwd), ...loopInput.history, ...appended],
            model: loopInput.model,
            tools: cwd !== undefined ? WORKSPACE_TOOLS : undefined,
          });

          if (result.toolCalls.length === 0) {
            const finalText = result.content ?? "";
            appended.push({ role: "assistant", content: finalText });
            return { appendedMessages: appended, finalText };
          }

          appended.push({
            role: "assistant",
            content: result.content,
            tool_calls: result.toolCalls,
          });

          for (const toolCall of result.toolCalls) {
            const argsSummary = toolCall.function.arguments.trim().slice(0, 200) || "{}";
            yield* publish({
              eventId: yield* nextEventId,
              provider: PROVIDER,
              threadId: loopInput.threadId,
              turnId: loopInput.turnId,
              createdAt: yield* nowIso,
              type: "item.started",
              payload: {
                itemType: "dynamic_tool_call",
                status: "inProgress",
                title: toolCall.function.name,
                detail: argsSummary,
              },
            });

            const approvalRequestType = WORKSPACE_APPROVAL_REQUIRED_TOOLS.get(
              toolCall.function.name,
            );
            const decision = approvalRequestType
              ? yield* requestApprovalIfNeeded({
                  session: loopInput.session,
                  threadId: loopInput.threadId,
                  turnId: loopInput.turnId,
                  requestType: approvalRequestType,
                  detail: argsSummary,
                })
              : "accept";

            // cwd is defined whenever tools were offered (the only way a
            // tool_call can exist), so this is never called without one.
            const toolResult =
              decision === "accept" || decision === "acceptForSession"
                ? yield* runWorkspaceTool(fs, cwd!, toolCall)
                : decision === "cancel"
                  ? "The user cancelled this action."
                  : "The user declined this action.";

            yield* publish({
              eventId: yield* nextEventId,
              provider: PROVIDER,
              threadId: loopInput.threadId,
              turnId: loopInput.turnId,
              createdAt: yield* nowIso,
              type: "item.completed",
              payload: {
                itemType: "dynamic_tool_call",
                status:
                  decision === "accept" || decision === "acceptForSession"
                    ? "completed"
                    : "declined",
                title: toolCall.function.name,
                detail: toolResult.trim().length > 0 ? toolResult.trim().slice(0, 2000) : "(empty)",
              },
            });

            appended.push({
              role: "tool",
              content: toolResult,
              tool_call_id: toolCall.id,
            });
          }
        }

        const finalText =
          "I hit the tool-call round limit while looking into this. Ask again to continue -- I'll pick up where I left off.";
        appended.push({ role: "assistant", content: finalText });
        return { appendedMessages: appended, finalText };
      });

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (turnInput) =>
      Effect.gen(function* () {
        const turnId = yield* nextTurnId;
        // Filled in once Effect.forkDetach below returns -- used by this
        // turn's own cleanup to avoid deleting a newer turn's registration
        // for the same thread (steering superseded this one and moved on).
        const selfFiberRef: {
          current: Fiber.Fiber<void, ProviderAdapterRequestError> | undefined;
        } = {
          current: undefined,
        };

        const work = Effect.gen(function* () {
          const session = sessions.get(turnInput.threadId);
          if (!session) {
            yield* publish({
              eventId: yield* nextEventId,
              provider: PROVIDER,
              threadId: turnInput.threadId,
              turnId,
              createdAt: yield* nowIso,
              type: "session.exited",
              payload: {
                reason: `Session for thread ${turnInput.threadId} not found.`,
                recoverable: false,
                exitKind: "error",
              },
            });
            return;
          }

          yield* publish({
            eventId: yield* nextEventId,
            provider: PROVIDER,
            threadId: turnInput.threadId,
            turnId,
            createdAt: yield* nowIso,
            type: "turn.started",
            payload: { model: turnInput.modelSelection?.model ?? input.defaultModel },
          });

          const userMessage: ChatMessage = { role: "user", content: turnInput.input ?? "" };

          const { appendedMessages, finalText } = yield* runToolLoop({
            session,
            model: turnInput.modelSelection?.model ?? input.defaultModel,
            history: session.messages,
            userMessage,
            threadId: turnInput.threadId,
            turnId,
          });

          // An interruptTurn/stopSession/stopAll that raced with this turn
          // already deleted the session -- writing it back here would
          // resurrect a session the caller explicitly tore down.
          if (sessions.has(turnInput.threadId)) {
            sessions.set(turnInput.threadId, {
              cwd: session.cwd,
              runtimeMode: session.runtimeMode,
              messages: [...session.messages, ...appendedMessages],
              turnMessageCounts: [...session.turnMessageCounts, appendedMessages.length],
              // Same Set reference as `session` -- requestApprovalIfNeeded may
              // have mutated it in place while the loop ran, and that has to
              // survive into the session record replacing `session` here.
              autoAcceptedRequestTypes: session.autoAcceptedRequestTypes,
            });
          }

          yield* publish({
            eventId: yield* nextEventId,
            provider: PROVIDER,
            threadId: turnInput.threadId,
            turnId,
            createdAt: yield* nowIso,
            type: "content.delta",
            payload: { streamKind: "assistant_text", delta: finalText },
          });

          yield* publish({
            eventId: yield* nextEventId,
            provider: PROVIDER,
            threadId: turnInput.threadId,
            turnId,
            createdAt: yield* nowIso,
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
              detail: finalText.trim().length > 0 ? finalText : "(empty)",
            },
          });

          yield* publish({
            eventId: yield* nextEventId,
            provider: PROVIDER,
            threadId: turnInput.threadId,
            turnId,
            createdAt: yield* nowIso,
            type: "turn.completed",
            payload: { state: "completed" },
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              // The pino JSON logger serializes a raw Cause as an opaque
              // { _id: 'Cause', failures: [Object] } blob -- Cause.pretty
              // renders the actual error chain into readable text.
              yield* Effect.logError(`${LABEL} adapter turn failed`, {
                cause: Cause.pretty(cause),
              });
              yield* publish({
                eventId: yield* nextEventId,
                provider: PROVIDER,
                threadId: turnInput.threadId,
                turnId,
                createdAt: yield* nowIso,
                type: "session.exited",
                payload: {
                  reason: (() => {
                    const squashed = Cause.squash(cause);
                    return squashed instanceof Error && squashed.message.length > 0
                      ? squashed.message
                      : `${LABEL} adapter turn failed.`;
                  })(),
                  recoverable: false,
                  exitKind: "error",
                },
              });
            }),
          ),
          // Drop this turn's own fiber registration once it finishes on its
          // own -- but only if nothing newer replaced it first (steering
          // starts a new turn on the same thread without this one ever
          // completing).
          Effect.ensuring(
            Effect.sync(() => {
              if (runningTurnFibers.get(turnInput.threadId) === selfFiberRef.current) {
                runningTurnFibers.delete(turnInput.threadId);
              }
            }),
          ),
        );

        // The caller (ProviderCommandReactor) runs sendTurn inside a
        // short-lived Effect.forkScoped fiber that completes the instant this
        // function returns. Effect.forkChild ties the forked fiber's lifetime
        // to that parent fiber, so `work` would be interrupted before it ever
        // reaches the HTTP call. Effect.forkDetach attaches it to the global
        // scope instead, so it survives past sendTurn's own return. Tracked
        // by thread so interruptTurn/stopSession/stopAll can actually
        // interrupt it -- a new turn superseding an old one on the same
        // thread is expected (steering), so this just overwrites.
        const fiber = yield* Effect.forkDetach(work);
        selfFiberRef.current = fiber;
        runningTurnFibers.set(turnInput.threadId, fiber);

        return { threadId: turnInput.threadId, turnId };
      });

    /**
     * Resolves ("cancel") every pending approval opened for `threadId`, so an
     * interrupted or stopped turn's requestApprovalIfNeeded doesn't hang
     * forever awaiting a decision nothing will ever send.
     */
    const cancelPendingApprovalsForThread = (threadId: ThreadId): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const [requestId, pending] of pendingApprovals) {
          if (pending.threadId !== threadId) {
            continue;
          }
          pendingApprovals.delete(requestId);
          yield* Deferred.succeed(pending.decision, "cancel");
        }
      });

    /**
     * Interrupts `threadId`'s in-flight sendTurn fiber, if one is still
     * running. Without this, interruptTurn/stopSession/stopAll only cleared
     * bookkeeping -- the HTTP call and tool loop kept running in the
     * background and eventually resurrected the session they were told to
     * tear down.
     */
    const interruptRunningTurnFiber = (threadId: ThreadId): Effect.Effect<void> =>
      Effect.gen(function* () {
        const fiber = runningTurnFibers.get(threadId);
        if (!fiber) {
          return;
        }
        runningTurnFibers.delete(threadId);
        yield* Fiber.interrupt(fiber);
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
      _threadId: ThreadId,
      _turnId?: TurnId,
    ) =>
      Effect.gen(function* () {
        yield* interruptRunningTurnFiber(_threadId);
        sessions.delete(_threadId);
        yield* cancelPendingApprovalsForThread(_threadId);
      });

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const pending = pendingApprovals.get(requestId);
        // A requestId is a correlation ID, not proof of ownership -- also
        // require it belongs to the thread the caller claims it's for.
        if (!pending || pending.threadId !== threadId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToRequest",
            issue: `No pending approval request '${requestId}' for this session.`,
          });
        }
        pendingApprovals.delete(requestId);
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
      _threadId: ThreadId,
      _requestId: string,
      _answers: unknown,
    ) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToUserInput",
          issue: "Structured user-input requests are not supported by this adapter.",
        }),
      );

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (
      threadId: ThreadId,
    ) =>
      Effect.gen(function* () {
        yield* interruptRunningTurnFiber(threadId);
        sessions.delete(threadId);
        yield* cancelPendingApprovalsForThread(threadId);
      });

    const listSessions: ProviderAdapterShape<ProviderAdapterError>["listSessions"] = () =>
      Effect.gen(function* () {
        const createdAt = yield* nowIso;
        const result: Array<{
          provider: typeof PROVIDER;
          status: "ready";
          runtimeMode: RuntimeMode;
          threadId: ThreadId;
          createdAt: string;
          updatedAt: string;
        }> = [];
        for (const [threadId, session] of sessions) {
          result.push({
            provider: PROVIDER,
            status: "ready",
            runtimeMode: session.runtimeMode,
            threadId,
            createdAt,
            updatedAt: createdAt,
          });
        }
        return result;
      });

    const hasSession: ProviderAdapterShape<ProviderAdapterError>["hasSession"] = (
      threadId: ThreadId,
    ) => Effect.succeed(sessions.has(threadId));

    const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (
      threadId: ThreadId,
    ) =>
      Effect.gen(function* () {
        const session = sessions.get(threadId);
        if (!session) {
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        }

        const turns: Array<ProviderThreadTurnSnapshot> = [];
        let cursor = 0;
        for (const count of session.turnMessageCounts) {
          const items = session.messages
            .slice(cursor, cursor + count)
            .map((message) => ({ role: message.role, content: message.content }));
          turns.push({ id: yield* nextTurnId, items });
          cursor += count;
        }

        return { threadId, turns } as ProviderThreadSnapshot;
      });

    const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
      threadId: ThreadId,
      numTurns: number,
    ) =>
      Effect.gen(function* () {
        const session = sessions.get(threadId);
        if (!session) {
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        }

        const keptTurnCounts = session.turnMessageCounts.slice(
          0,
          Math.max(0, session.turnMessageCounts.length - numTurns),
        );
        const keptMessageCount = keptTurnCounts.reduce((sum, count) => sum + count, 0);
        const keptMessages = session.messages.slice(0, keptMessageCount);

        sessions.set(threadId, {
          cwd: session.cwd,
          runtimeMode: session.runtimeMode,
          messages: keptMessages,
          turnMessageCounts: keptTurnCounts,
          autoAcceptedRequestTypes: session.autoAcceptedRequestTypes,
        });

        const turns: Array<ProviderThreadTurnSnapshot> = [];
        let cursor = 0;
        for (const count of keptTurnCounts) {
          const items = keptMessages
            .slice(cursor, cursor + count)
            .map((message) => ({ role: message.role, content: message.content }));
          turns.push({ id: yield* nextTurnId, items });
          cursor += count;
        }

        return { threadId, turns } as ProviderThreadSnapshot;
      });

    const stopAll: ProviderAdapterShape<ProviderAdapterError>["stopAll"] = () =>
      Effect.gen(function* () {
        for (const [threadId, fiber] of runningTurnFibers) {
          runningTurnFibers.delete(threadId);
          yield* Fiber.interrupt(fiber);
        }
        sessions.clear();
        for (const [requestId, pending] of pendingApprovals) {
          pendingApprovals.delete(requestId);
          yield* Deferred.succeed(pending.decision, "cancel");
        }
      });

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(events),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
