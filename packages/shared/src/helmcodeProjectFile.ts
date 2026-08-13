import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { HelmCodeProjectFile, HELMCODE_PROJECT_FILE_SCHEMA_URL } from "@helmcode/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `helmcode.json` file contents (lenient JSONC string) and the
 * decoded {@link HelmCodeProjectFile}.
 */
export const HelmCodeProjectFileFromJson = fromLenientJson(HelmCodeProjectFile);

const decodeHelmCodeProjectFile = Schema.decodeExit(HelmCodeProjectFileFromJson);

/**
 * Decode raw `helmcode.json` contents, treating invalid or malformed files as
 * absent. Clients use this to read optional defaults (scripts, thread env
 * mode) without surfacing decode errors to the user.
 */
export function parseHelmCodeProjectFile(contents: string): HelmCodeProjectFile | null {
  const decoded = decodeHelmCodeProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

/**
 * Build the publishable JSON Schema document for `helmcode.json` (draft 2020-12).
 *
 * Served from the marketing site at {@link HELMCODE_PROJECT_FILE_SCHEMA_URL} so
 * editors get LSP support via a `$schema` reference.
 */
export function buildHelmCodeProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(HelmCodeProjectFile);
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: HELMCODE_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
