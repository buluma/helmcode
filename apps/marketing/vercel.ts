import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  installCommand: "npm install -g vite-plus && vp install --filter '@helmcode/marketing...'",
  buildCommand: "vp run --filter @helmcode/marketing build",
  outputDirectory: "dist",
};
