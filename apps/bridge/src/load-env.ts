import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function unquote(value: string): string {
  if (value.length < 2) {
    return value;
  }

  const first = value[0];
  const last = value[value.length - 1];
  if ((first !== '"' && first !== "'") || first !== last) {
    return value;
  }

  const inner = value.slice(1, -1);
  if (first === "'") {
    return inner;
  }

  return inner.replaceAll("\\n", "\n").replaceAll("\\r", "\r").replaceAll("\\t", "\t").replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

function parseDotenv(contents: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, equalsIndex).trim();
    if (key.length === 0) {
      continue;
    }

    const value = normalized.slice(equalsIndex + 1).trim();
    entries.push([key, unquote(value)]);
  }

  return entries;
}

export function loadRepoRootEnv(envPath = fileURLToPath(new URL("../../../.env", import.meta.url))): void {
  let resolvedEnvPath = envPath;

  if (!existsSync(resolvedEnvPath)) {
    let currentDir = dirname(fileURLToPath(import.meta.url));
    while (true) {
      const candidate = join(currentDir, ".env");
      if (existsSync(candidate)) {
        resolvedEnvPath = candidate;
        break;
      }

      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) {
        return;
      }

      currentDir = parentDir;
    }
  }

  const entries = parseDotenv(readFileSync(resolvedEnvPath, "utf8"));
  for (const [key, value] of entries) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
