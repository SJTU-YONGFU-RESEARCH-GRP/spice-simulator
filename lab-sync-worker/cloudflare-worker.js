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
const REQUEST_BODY_LIMIT = 256_000;
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 4_000;
const MAX_TRIGGER_LENGTH = 32;

function corsHeaders(env, requestOrigin) {
  const origins = allowedOrigins(env);
  const origin = requestOrigin && origins.includes(requestOrigin)
    ? requestOrigin
    : (origins[0] || "*");
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status, env, requestOrigin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders(env, requestOrigin),
    },
  });
}

function allowedOrigins(env) {
  return String(
    env.ALLOW_ORIGIN || "https://sjtu-yongfu-research-grp.github.io",
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isAllowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  // Non-browser callers do not send Origin. Keep health checks and server-side
  // integrations working, while browser requests must match the allow-list.
  return !origin || allowedOrigins(env).includes("*") || allowedOrigins(env).includes(origin);
}

function oneLineText(value, maxLength, fallback = "") {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\r\n]+/gu, " ").trim();
  return normalized.slice(0, maxLength);
}

function fencedJson(value) {
  const source = JSON.stringify(value, null, 2);
  const longestRun = Math.max(
    0,
    ...Array.from(source.matchAll(/`+/gu), (match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return [(`${fence}json`), source, fence];
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
    lines.push(...fencedJson(payload.project));
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
  const requestOrigin = request.headers.get("Origin") || undefined;
  const respond = (data, status) => json(data, status, env, requestOrigin);
  if (!isAllowedOrigin(request, env)) {
    return respond({ ok: false, error: "Origin not allowed" }, 403);
  }

  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > REQUEST_BODY_LIMIT) {
    return respond({ ok: false, error: "Request body is too large" }, 413);
  }

  let incoming;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > REQUEST_BODY_LIMIT) {
      return respond({ ok: false, error: "Request body is too large" }, 413);
    }
    incoming = JSON.parse(raw);
  } catch {
    return respond({ ok: false, error: "Invalid JSON" }, 400);
  }

  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return respond({ ok: false, error: "Payload must be a JSON object" }, 400);
  }
  if (incoming.schema !== SCHEMA) {
    return respond({ ok: false, error: "Unsupported schema" }, 400);
  }
  if (incoming.consent !== true) {
    return respond({ ok: false, error: "Consent required" }, 400);
  }
  if (!incoming.project && !incoming.oversized) {
    return respond({ ok: false, error: "Missing project" }, 400);
  }
  if (incoming.project !== undefined && incoming.project !== null &&
      (typeof incoming.project !== "object" || Array.isArray(incoming.project))) {
    return respond({ ok: false, error: "Project must be a JSON object" }, 400);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (!ip) {
    return respond(
      { ok: false, error: "Could not resolve client address" },
      400,
    );
  }
  const salt = env.IP_HASH_SALT || "";
  if (!salt) {
    return respond({ ok: false, error: "IP_HASH_SALT is not configured" }, 500);
  }

  const actorKey = await sha256Hex(`${salt}:${ip}`);
  const actorShort = actorKey.slice(0, 16);

  const name = oneLineText(incoming.name, MAX_NAME_LENGTH, "Untitled circuit") || "Untitled circuit";
  const projectJson = incoming.project ? JSON.stringify(incoming.project) : "";
  const reportedProjectBytes = Number(incoming.projectBytes);
  const projectBytes =
    Number.isFinite(reportedProjectBytes) && reportedProjectBytes >= 0
      ? reportedProjectBytes
      : new TextEncoder().encode(projectJson).byteLength;
  const oversized =
    Boolean(incoming.oversized) || projectBytes > ISSUE_BODY_SOFT_LIMIT;

  const payload = {
    schema: SCHEMA,
    name,
    description: oneLineText(incoming.description, MAX_DESCRIPTION_LENGTH),
    createdAt:
      typeof incoming.createdAt === "string" && !Number.isNaN(Date.parse(incoming.createdAt))
        ? incoming.createdAt
        : new Date().toISOString(),
    trigger: oneLineText(incoming.trigger, MAX_TRIGGER_LENGTH, "save") || "save",
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
    return respond({ ok: false, error: "GITHUB_OWNER/REPO not set" }, 500);
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

  return respond(
    {
      ok: true,
      updated,
      issue_number: issueNumber,
      issue_url: issue.html_url,
    },
    200,
  );
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(env, request.headers.get("Origin") || undefined),
      });
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
          request.headers.get("Origin") || undefined,
        );
      }
    }
    return json({ ok: false, error: "Not found" }, 404, env);
  },
};
