import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const site = resolve(root, "site");

async function mustRead(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Missing or unreadable ${relative(root, path)}: ${error.message}`);
  }
}

async function mustExist(path) {
  try {
    await access(path);
  } catch {
    throw new Error(`Referenced file does not exist: ${relative(root, path)}`);
  }
}

const index = await mustRead(resolve(site, "index.html"));
const manifest = JSON.parse(await mustRead(resolve(site, "manifest.webmanifest")));
const release = JSON.parse(await mustRead(resolve(site, "release-manifest.json")));
const packageJson = JSON.parse(await mustRead(resolve(root, "package.json")));
const version = (await mustRead(resolve(root, "VERSION"))).trim();

if (!index.includes('<div id="root"></div>')) {
  throw new Error("site/index.html does not contain the application root");
}
if (!index.includes("/spice-simulator/")) {
  throw new Error("site/index.html is missing the Pages base path");
}
if (release.version !== packageJson.version || release.version !== version) {
  throw new Error(
    `Version mismatch: package=${packageJson.version}, VERSION=${version}, release=${release.version}`,
  );
}
if (release.versionSource !== "package.json") {
  throw new Error("release-manifest.versionSource must be package.json");
}
if (manifest.scope !== "./" || manifest.start_url !== "./") {
  throw new Error("PWA manifest must stay relative to the deployed site scope");
}

const references = new Set();
for (const match of index.matchAll(/(?:src|href)="([^"#?]+)"/gu)) {
  const value = match[1];
  if (value.startsWith("/spice-simulator/")) {
    references.add(value.slice("/spice-simulator/".length));
  }
}
for (const asset of references) {
  await mustExist(resolve(site, asset));
}
const assetNames = await (await import("node:fs/promises")).readdir(
  resolve(site, "assets"),
);
const keyBundles = assetNames.filter((name) =>
  /^(?:index|App|project-file-service|src-Dahg1Dl_).*\.js$/u.test(name),
);
if (keyBundles.length < 4) {
  throw new Error("Expected index, App, project service, and netlist bundles");
}
for (const bundle of keyBundles) {
  const check = spawnSync(process.execPath, ["--check", resolve(site, "assets", bundle)], {
    encoding: "utf8",
  });
  if (check.status !== 0) {
    throw new Error(`JavaScript bundle failed to parse: ${bundle}\n${check.stderr}`);
  }
}
for (const required of ["404.html", "sw.js", "manifest.webmanifest", "release-manifest.json"]) {
  await mustExist(resolve(site, required));
}

console.log(
  `Verified site shell, ${references.size} referenced assets, ${keyBundles.length} key bundles, and version ${version}.`,
);
