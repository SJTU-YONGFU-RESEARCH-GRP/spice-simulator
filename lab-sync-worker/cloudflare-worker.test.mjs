import assert from "node:assert/strict";
import test from "node:test";

import worker from "./cloudflare-worker.js";

const endpoint = "https://worker.example/";
const allowedOrigin = "https://sjtu-yongfu-research-grp.github.io";

function environment(overrides = {}) {
  return {
    ALLOW_ORIGIN: allowedOrigin,
    GITHUB_OWNER: "owner",
    GITHUB_REPO: "repo",
    GITHUB_TOKEN: "test-token",
    IP_HASH_SALT: "test-salt",
    ...overrides,
  };
}

function post(body, headers = {}) {
  return new Request(endpoint, {
    method: "POST",
    headers: {
      "CF-Connecting-IP": "203.0.113.7",
      "Content-Type": "application/json",
      Origin: allowedOrigin,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function validPayload(overrides = {}) {
  return {
    schema: "spice_icproj_share_v1",
    consent: true,
    name: "CMOS amplifier",
    project: { documents: [] },
    ...overrides,
  };
}

test("health endpoint does not require GitHub credentials", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example/health"),
    {},
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "spice-lab-sync",
  });
});

test("rejects browser writes from an untrusted origin", async () => {
  const response = await worker.fetch(
    post(validPayload(), { Origin: "https://attacker.example" }),
    environment(),
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Origin not allowed");
});

test("rejects oversized bodies before parsing JSON", async () => {
  const response = await worker.fetch(
    post("{}", { "Content-Length": "256001" }),
    environment(),
  );
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, "Request body is too large");
});

test("requires a project object", async () => {
  const response = await worker.fetch(
    post(validPayload({ project: ["not", "a", "project"] })),
    environment(),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Project must be a JSON object");
});

test("sanitizes issue fields and protects the JSON code fence", async (t) => {
  let githubRequest;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, init) => {
    githubRequest = { url: String(url), init };
    return Response.json({ number: 42, html_url: "https://github.example/42" });
  };

  const response = await worker.fetch(
    post(
      validPayload({
        name: "Amplifier\nInjected heading",
        description: "first line\r\nsecond line",
        project: { note: "``` tries to close the fence" },
        projectBytes: -1,
      }),
    ),
    environment(),
  );

  assert.equal(response.status, 200);
  assert.equal(githubRequest.url, "https://api.github.com/repos/owner/repo/issues");
  const issue = JSON.parse(githubRequest.init.body);
  assert.equal(issue.title, "[icproj] Amplifier Injected heading");
  assert.match(issue.body, /first line second line/u);
  assert.match(issue.body, /````json[\s\S]*``` tries to close the fence[\s\S]*````/u);
  assert.doesNotMatch(issue.body, /Size: -1 bytes/u);
});
