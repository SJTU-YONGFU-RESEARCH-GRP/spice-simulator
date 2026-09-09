/**
 * Cloudflare Worker: auto lab backup for SPICE editor Save/Export.
 *
 * - Client never sends IP.
 * - Worker reads CF-Connecting-IP, hashes with IP_HASH_SALT → actor key.
 * - KV maps actor key → issue number (same IP reuses / replaces one issue).
 * - Issue body never contains IP (or the full actor hash).
 *
 * Secrets: GITHUB_TOKEN, IP_HASH_SALT
 * Vars: GITHUB_OWNER, GITHUB_REPO, ALLOW_ORIGIN
 * KV: LAB_ACTORS
 */

const SCHEMA = "spice_icproj_share_v1";
const ISSUE_BODY_SOFT_LIMIT = 55_000;

function corsHeaders(env) {
  const origin = env.ALLOW_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders(env),
    },
  });
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function formatIssueMarkdown(payload) {
  const lines = [
    `## ${payload.name}`,
    "",
    payload.description || "_No description._",
    "",
    "### Share meta",
    "",
    `- Schema: \`${payload.schema}\``,
    `- Trigger: \`${payload.trigger || "save"}\``,
    `- Created: ${payload.createdAt}`,
    `- Size: ${payload.projectBytes} bytes`,
    "- Approximate location: _(not shared)_",
    "- Client IP: _(not stored in this issue; private actor key only)_",
    "",
    "### Project",
    "",
  ];
  if (payload.oversized || !payload.project) {
    lines.push(
      payload.note ||
        "Project omitted (too large). Attach `*.icproj.json` manually.",
    );
  } else {
    lines.push("```json", JSON.stringify(payload.project, null, 2), "```");
  }
  lines.push("");
  return lines.join("\n");
}

async function github(env, path, init = {}) {
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not configured");
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "spice-lab-sync-worker",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const message =
      (body && (body.message || body.error)) ||
      `GitHub API ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function handlePost(request, env) {
  let incoming;
  try {
    incoming = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400, env);
  }

  if (incoming?.schema !== SCHEMA) {
    return json({ ok: false, error: "Unsupported schema" }, 400, env);
  }
  if (incoming?.consent !== true) {
    return json({ ok: false, error: "Consent required" }, 400, env);
  }
  if (!incoming.project && !incoming.oversized) {
    return json({ ok: false, error: "Missing project" }, 400, env);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (!ip) {
    return json(
      { ok: false, error: "Could not resolve client address" },
      400,
      env,
    );
  }
  const salt = env.IP_HASH_SALT || "";
  if (!salt) {
    return json({ ok: false, error: "IP_HASH_SALT is not configured" }, 500, env);
  }

  const actorKey = await sha256Hex(`${salt}:${ip}`);
  const actorShort = actorKey.slice(0, 16);

  const name =
    typeof incoming.name === "string" && incoming.name.trim()
      ? incoming.name.trim()
      : "Untitled circuit";
  const projectJson = incoming.project ? JSON.stringify(incoming.project) : "";
  const projectBytes =
    typeof incoming.projectBytes === "number"
      ? incoming.projectBytes
      : projectJson.length;
  const oversized =
    Boolean(incoming.oversized) || projectBytes > ISSUE_BODY_SOFT_LIMIT;

  const payload = {
    schema: SCHEMA,
    name,
    description:
      typeof incoming.description === "string" ? incoming.description : "",
    createdAt: incoming.createdAt || new Date().toISOString(),
    trigger: incoming.trigger || "save",
    project: oversized ? null : incoming.project,
    projectBytes,
    oversized,
    note: oversized
      ? "Project exceeds the GitHub issue body budget."
      : null,
  };

  const title = `[icproj] ${name}`;
  const body = formatIssueMarkdown(payload);
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  if (!owner || !repo) {
    return json({ ok: false, error: "GITHUB_OWNER/REPO not set" }, 500, env);
  }

  let issueNumber = null;
  if (env.LAB_ACTORS) {
    const stored = await env.LAB_ACTORS.get(actorShort);
    if (stored && /^\d+$/.test(stored)) issueNumber = Number(stored);
  }

  let issue;
  let updated = false;
  if (issueNumber) {
    try {
      issue = await github(env, `/repos/${owner}/${repo}/issues/${issueNumber}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body, state: "open" }),
      });
      updated = true;
    } catch (error) {
      // Stale mapping — create a fresh issue.
      if (error.status !== 404) throw error;
      issueNumber = null;
    }
  }

  if (!issueNumber) {
    issue = await github(env, `/repos/${owner}/${repo}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        body,
        labels: ["icproj", "lab-sync"],
      }),
    });
    issueNumber = issue.number;
    if (env.LAB_ACTORS) {
      await env.LAB_ACTORS.put(actorShort, String(issueNumber));
    }
  }

  return json(
    {
      ok: true,
      updated,
      issue_number: issueNumber,
      issue_url: issue.html_url,
    },
    200,
    env,
  );
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "spice-lab-sync" }, 200, env);
    }
    if (request.method === "POST" && (url.pathname === "/" || url.pathname === "")) {
      try {
        return await handlePost(request, env);
      } catch (error) {
        return json(
          { ok: false, error: error.message || "Worker error" },
          error.status && error.status < 500 ? error.status : 502,
          env,
        );
      }
    }
    return json({ ok: false, error: "Not found" }, 404, env);
  },
};
