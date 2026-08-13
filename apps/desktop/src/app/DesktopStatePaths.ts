import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(helmcodeHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(helmcodeHome)) {
    return Option.none();
  }
  const trimmed = helmcodeHome.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly helmcodeHome: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.helmcodeHome), () =>
    input.joinPath(input.homeDirectory, ".helmcode"),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly helmcodeHome: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.helmcodeHome));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
