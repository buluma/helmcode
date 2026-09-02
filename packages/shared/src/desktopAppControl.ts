import { sha256 } from "@noble/hashes/sha2";

export interface DesktopAppControlAddress {
  readonly address: string;
  readonly directory: string | null;
}

function shortHash(value: string): string {
  return Array.from(sha256(new TextEncoder().encode(value)).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Returns the local-only socket address shared by the desktop shell and CLI.
 * The state directory is hashed so custom Helm Code homes cannot exceed Unix socket
 * path limits.
 */
export function resolveDesktopAppControlAddress(input: {
  readonly stateDir: string;
  readonly platform: NodeJS.Platform;
  readonly tempDir: string;
  readonly userId: number | undefined;
  readonly joinPath: (...segments: readonly string[]) => string;
}): DesktopAppControlAddress {
  const stateHash = shortHash(input.stateDir);
  if (input.platform === "win32") {
    return {
      address: `\\\\.\\pipe\\helmcode-app-${stateHash}`,
      directory: null,
    };
  }

  // Falls back to a slice of the already-computed state hash, not a second
  // hash of it — not user-specific, but still unique enough to segment the
  // temp directory when no OS uid is available (e.g. Windows, sandboxed).
  const identityKey = input.userId === undefined ? stateHash.slice(0, 12) : input.userId;
  const directory = input.joinPath(input.tempDir, `helmcode-${identityKey}`);
  return {
    address: input.joinPath(directory, `${stateHash}.sock`),
    directory,
  };
}
