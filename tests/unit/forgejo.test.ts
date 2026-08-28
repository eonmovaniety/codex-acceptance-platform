import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectConfig } from "../../src/domain.js";
import {
  ForgejoClient,
  forgejoProviderConfig,
  type ForgejoFetch,
} from "../../src/forgejo.js";

const config: ProjectConfig = {
  version: 1,
  project_id: "forgejo-fixture",
  display_name: "Forgejo fixture",
  repository: { base_branch: "master" },
  automation: {
    enabled: true,
    tasks: [{ task_id: "TASK-001", contract: ".acceptance/contract.yaml" }],
    ci: {
      provider: "forgejo-poll",
      server_url: "http://192.168.31.9:3000/",
      owner: "Silmaril",
      repo: "atmosphere-engine",
      credential_ref: "cap-secret://forgejo/Silmaril",
      status_context: "cap/atmosphere-acceptance",
      mirror_remote: "github",
    },
  },
};

test("Forgejo provider normalizes and validates configuration", () => {
  assert.deepEqual(forgejoProviderConfig(config), {
    serverUrl: "http://192.168.31.9:3000",
    owner: "Silmaril",
    repo: "atmosphere-engine",
    credentialRef: "cap-secret://forgejo/Silmaril",
    statusContext: "cap/atmosphere-acceptance",
    mirrorRemote: "github",
  });
  assert.throws(
    () =>
      forgejoProviderConfig({
        ...config,
        automation: {
          ...config.automation!,
          ci: { ...config.automation!.ci!, credential_ref: "C:/token.txt" },
        },
      }),
    /cap-secret/,
  );
});

test("Forgejo client sends authenticated pending and final status payloads", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const request: ForgejoFetch = async (input, init) => {
    requests.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const provider = forgejoProviderConfig(config)!;
  const client = new ForgejoClient(
    provider,
    "test-token-01234567890123456789",
    request,
  );
  await client.status("abc123", "pending", "CAP queued");
  await client.status("abc123", "success", "CAP passed");
  assert.equal(requests.length, 2);
  assert.match(requests[0]!.url, /statuses\/abc123$/);
  assert.equal(
    (requests[0]!.init?.headers as Record<string, string>).authorization,
    "token test-token-01234567890123456789",
  );
  assert.deepEqual(JSON.parse(String(requests[1]!.init?.body)), {
    state: "success",
    context: "cap/atmosphere-acceptance",
    description: "CAP passed",
  });
});
