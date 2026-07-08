import { existsSync } from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";

export type EnvLoadResult = {
  loaded: boolean;
  path: string;
};

export function loadEnvFile(envFile?: string): EnvLoadResult {
  const envPath = path.resolve(process.cwd(), envFile ?? ".env");

  if (!existsSync(envPath)) {
    if (envFile) {
      throw new Error(`Env file not found: ${envPath}`);
    }

    return {
      loaded: false,
      path: envPath,
    };
  }

  const result = loadDotenv({
    path: envPath,
    override: false,
    quiet: true,
  });

  if (result.error) {
    throw result.error;
  }

  return {
    loaded: true,
    path: envPath,
  };
}
