import type { APIRoute } from "astro";

import { buildHelmCodeProjectFileJsonSchema } from "@helmcode/shared/helmcodeProjectFile";

// Rendered at build time; published at https://t3.codes/schema/t3.json so
// helmcode.json files can reference it via "$schema" for editor/LSP support.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildHelmCodeProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
