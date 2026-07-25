import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRepoRootEnv } from "./load-env.js";

test("loadRepoRootEnv fills missing env vars without overriding shell values", () => {
  const dir = mkdtempSync(join(tmpdir(), "clickup-openclaw-env-"));
  const envPath = join(dir, ".env");
  writeFileSync(
    envPath,
    [
      "CLICKUP_API_TOKEN=from-file",
      'CLICKUP_BASE_URL="https://example.invalid/api/v2"',
      "export DEFAULT_WORK_TYPE=smoke",
      "IGNORED_LINE",
      "",
    ].join("\n"),
  );

  const originalToken = process.env.CLICKUP_API_TOKEN;
  const originalBaseUrl = process.env.CLICKUP_BASE_URL;
  const originalDefaultWorkType = process.env.DEFAULT_WORK_TYPE;

  try {
    process.env.CLICKUP_API_TOKEN = "from-shell";
    delete process.env.CLICKUP_BASE_URL;
    delete process.env.DEFAULT_WORK_TYPE;

    loadRepoRootEnv(envPath);

    assert.equal(process.env.CLICKUP_API_TOKEN, "from-shell");
    assert.equal(process.env.CLICKUP_BASE_URL, "https://example.invalid/api/v2");
    assert.equal(process.env.DEFAULT_WORK_TYPE, "smoke");
  } finally {
    if (originalToken === undefined) {
      delete process.env.CLICKUP_API_TOKEN;
    } else {
      process.env.CLICKUP_API_TOKEN = originalToken;
    }

    if (originalBaseUrl === undefined) {
      delete process.env.CLICKUP_BASE_URL;
    } else {
      process.env.CLICKUP_BASE_URL = originalBaseUrl;
    }

    if (originalDefaultWorkType === undefined) {
      delete process.env.DEFAULT_WORK_TYPE;
    } else {
      process.env.DEFAULT_WORK_TYPE = originalDefaultWorkType;
    }
  }
});
