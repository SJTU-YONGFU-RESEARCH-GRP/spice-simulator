import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repositoryRoot = dirname(
  dirname(dirname(fileURLToPath(import.meta.url))),
);

function installDomShim() {
  const noop = () => {};
  const element = () => ({
    relList: { supports: () => true },
    setAttribute: noop,
    append: noop,
    appendChild: noop,
    removeChild: noop,
    style: {},
    classList: { add: noop, remove: noop, contains: () => false },
    ownerDocument: null,
    addEventListener: noop,
    removeEventListener: noop,
    nodeType: 1,
    nodeName: "DIV",
  });
  const rootElement = element();
  globalThis.document = {
    createElement: element,
    querySelectorAll: () => [],
    getElementById: (id) => (id === "root" ? rootElement : null),
    head: { append: noop },
    body: element(),
    documentElement: {
      style: {},
      classList: { add: noop, remove: noop, contains: () => false },
    },
  };
  globalThis.MutationObserver = class {
    observe() {}
  };
  globalThis.window = globalThis;
  globalThis.location = { pathname: "/spice-simulator/" };
}

export async function loadHashedBundle(prefix) {
  const asset = (await readdir(join(repositoryRoot, "site", "assets"))).find(
    (name) => name.startsWith(prefix) && name.endsWith(".js"),
  );
  if (!asset) throw new Error(`${prefix} bundle is missing`);
  installDomShim();
  const previousSetImmediate = globalThis.setImmediate;
  globalThis.setImmediate = () => 0;
  try {
    return await import(
      pathToFileURL(join(repositoryRoot, "site", "assets", asset))
    );
  } finally {
    globalThis.setImmediate = previousSetImmediate;
  }
}
