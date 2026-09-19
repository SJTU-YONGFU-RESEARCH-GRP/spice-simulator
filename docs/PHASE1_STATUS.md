# Phase 1 trust status

## Version authority

`package.json` is the release version authority. `VERSION`,
`site/release-manifest.json`, and the generated Pages metadata must match it.
`npm run verify:site` checks this invariant and verifies that the manifest's
`versionSource` is `package.json`.

## External editor-source boundary

This checkout is the public Pages shell. The editor source is expected in a
private/sibling checkout (`../spice-simulator-editor` or the legacy
`../analog-canvas-js`), but neither checkout is available in this environment.
Consequently, the checked-in minified editor bundle still contains an embedded
package metadata version from the older build. It was not rewritten by hand:
doing so would make a release appear fixed while leaving the source build
incorrect. The verification scripts therefore protect the public release
metadata and record this source-build blocker explicitly.

To remove the blocker, make the editor source available, update its package
version from the root release version during the build, regenerate `site/`,
and rerun `npm run verify:site` before publishing.

## Testbench/DUT guidance boundary

The Testbench/DUT entry flow belongs to that unavailable editor source. This
public shell cannot safely add the UI prompt without its component and
simulation-state code. The required follow-up must check for:

- a Testbench and a DUT before entering simulation;
- input, output, ground, and analysis type selections;
- actionable remediation (where to add the missing item), not a raw parser
  exception.

This is an explicit Phase 1 blocker, not a simulated implementation.
