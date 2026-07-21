import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { BridgeConfig } from "./config.js";

type RepoUrlResolverDeps = {
  cwd?: string;
  execFileSync?: typeof execFileSync;
  readFileSync?: typeof readFileSync;
  readGitTopLevel?: (cwd: string) => string | undefined;
};

export function normalizeRepoUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  const withoutPrefix = trimmed.startsWith("git+") ? trimmed.slice(4) : trimmed;
  const cleaned = withoutPrefix.replace(/\.git$/u, "");

  if (cleaned.startsWith("http://") || cleaned.startsWith("https://")) {
    return cleaned;
  }

  const sshMatch = cleaned.match(/^git@([^:]+):(.+)$/u);
  if (sshMatch !== null) {
    return `https://${sshMatch[1]}/${sshMatch[2]}`;
  }

  const sshUrlMatch = cleaned.match(/^ssh:\/\/git@([^/]+)\/(.+)$/u);
  if (sshUrlMatch !== null) {
    return `https://${sshUrlMatch[1]}/${sshUrlMatch[2]}`;
  }

  const githubShortcutMatch = cleaned.match(/^github:([^/]+)\/(.+)$/u);
  if (githubShortcutMatch !== null) {
    return `https://github.com/${githubShortcutMatch[1]}/${githubShortcutMatch[2]}`;
  }

  return cleaned;
}

function readPackageRepositoryUrl(
  packageJsonPath: string,
  deps: Required<Pick<RepoUrlResolverDeps, "readFileSync">>,
): string | undefined {
  try {
    const raw = deps.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as {
      repository?: string | { url?: string };
    };

    if (typeof parsed.repository === "string") {
      return normalizeRepoUrl(parsed.repository);
    }

    if (parsed.repository !== undefined && typeof parsed.repository.url === "string") {
      return normalizeRepoUrl(parsed.repository.url);
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function findRepositoryUrlFromManifests(
  startDir: string,
  deps: Required<Pick<RepoUrlResolverDeps, "readFileSync" | "readGitTopLevel">>,
): string | undefined {
  const stopDir = deps.readGitTopLevel(startDir) ?? path.parse(startDir).root;

  for (let currentDir = startDir; ; currentDir = path.dirname(currentDir)) {
    const packageJsonPath = path.join(currentDir, "package.json");
    const repositoryUrl = readPackageRepositoryUrl(packageJsonPath, deps);
    if (repositoryUrl !== undefined) {
      return repositoryUrl;
    }

    if (currentDir === stopDir || path.dirname(currentDir) === currentDir) {
      return undefined;
    }
  }
}

function readGitTopLevel(
  cwd: string,
  deps: Required<Pick<RepoUrlResolverDeps, "execFileSync">>,
): string | undefined {
  try {
    const topLevel = deps.execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    return topLevel.length > 0 ? topLevel : undefined;
  } catch {
    return undefined;
  }
}

function readGitRemoteUrl(
  cwd: string,
  deps: Required<Pick<RepoUrlResolverDeps, "execFileSync">>,
): string | undefined {
  try {
    const remoteUrl = deps.execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    return remoteUrl.length > 0 ? normalizeRepoUrl(remoteUrl) : undefined;
  } catch {
    return undefined;
  }
}

export function resolveRepoUrl(
  config: BridgeConfig,
  deps: RepoUrlResolverDeps = {},
): string | undefined {
  const cwd = deps.cwd ?? process.cwd();
  const exec = deps.execFileSync ?? execFileSync;
  const read = deps.readFileSync ?? readFileSync;
  const topLevel =
    deps.readGitTopLevel ?? ((inputCwd: string) => readGitTopLevel(inputCwd, { execFileSync: exec }));

  const explicitRepoUrl = config.REPO_URL ?? config.CLICKUP_REPO_URL;
  if (explicitRepoUrl !== undefined) {
    return normalizeRepoUrl(explicitRepoUrl);
  }

  const gitRemoteUrl = readGitRemoteUrl(cwd, { execFileSync: exec });
  if (gitRemoteUrl !== undefined) {
    return gitRemoteUrl;
  }

  return findRepositoryUrlFromManifests(cwd, { readFileSync: read, readGitTopLevel: topLevel });
}
