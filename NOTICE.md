# NOTICE — SPICE Simulator (schematic editor)

This directory is a **derivative work** of Analog Canvas, shipped as the
SPICE Simulator editor source / Pages build:

> Analog Canvas — https://github.com/cascode-ai/analog-canvas  
> Copyright © 2026 Zengchun Chen and Zhishuai Zhang  
> Licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`)

See `LICENSE.md` for the full license text.

## What changed in this fork

- Sources mechanically converted from TypeScript to JavaScript (types stripped).
- Cloudflare `worker/` (Gallery, cloud accounts, remote project APIs) is **excluded**
  from the default client-only layout so circuits stay on the user's machine.
- Goal: easier local modification and static/client deployment **without sending
  schematic data to a backend**.
- Public product name for this deployment: **SPICE Simulator**
  (`spice-simulator` Pages host).

Converting language or later edits does **not** remove AGPL obligations. If you
distribute this software, or offer a modified version over a network, you must
provide Corresponding Source under AGPL-3.0-only.
