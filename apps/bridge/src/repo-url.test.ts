import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.js";
import { resolveRepoUrl } from "./repo-url.js";

test("resolveRepoUrl resolves explicit config, git remote, and manifest fallback", () => {
  const config = loadConfig({
    CLICKUP_API_TOKEN: "token",
    PORT: "8787",
    HOST: "0.0.0.0",
  });

  assert.equal(
    resolveRepoUrl({
      ...config,
      CLICKUP_REPO_URL: "git+ssh://git@github.com/acme/widgets.git",
    }),
    "https://github.com/acme/widgets",
  );

  assert.equal(
    resolveRepoUrl(config, {
      cwd: "/repo",
      execFileSync: ((command: string, args: readonly string[]) => {
        assert.equal(command, "git");
        assert.deepEqual(args, ["remote", "get-url", "origin"]);
        return "git@github.com:acme/widgets.git\n";
      }) as never,
      readGitTopLevel: () => "/repo",
      readFileSync: (() => {
        throw new Error("manifest fallback should not be used when git remote exists");
      }) as never,
    }),
    "https://github.com/acme/widgets",
  );

  assert.equal(
    resolveRepoUrl(config, {
      cwd: "/repo/apps/bridge",
      execFileSync: (() => {
        throw new Error("git remote should be ignored for this test");
      }) as never,
      readGitTopLevel: () => "/repo",
      readFileSync: ((filePath: string) => {
        if (filePath === "/repo/apps/bridge/package.json") {
          return JSON.stringify({
            repository: { url: "git+https://github.com/acme/widgets.git" },
          });
        }

        throw new Error(`unexpected read of ${filePath}`);
      }) as never,
    }),
    "https://github.com/acme/widgets",
  );
});
