# Project data states and privacy boundaries

The editor has three intentionally separate data states. A project starts in
`local`; it never enters `cloud` or `lab` without an explicit user action.

| State | Data flow | Trigger | Failure behavior | Privacy boundary |
|---|---|---|---|---|
| **local** | Browser memory and the browser's local project storage | Editing, local Save, Import/Export | Keep the local document and show an actionable local error; do not retry by uploading | Data stays in the user's browser/device unless the user exports or shares it |
| **cloud** | A configured remote synchronization/storage service | User enables remote sync or uses a cloud save action | Keep the local copy, report sync failure, and allow retry; never treat a failed sync as a successful save | Only the configured cloud provider receives the selected project and its metadata |
| **lab** | The opt-in lab-sync endpoint, then the private `spice-simulator-lab` GitHub repository | User explicitly chooses Lab backup/Share and confirms consent | Reject without consent; surface the endpoint error; local data remains available | The Worker requires `consent: true`, accepts only the configured origin, and stores no raw IP in the issue body. It hashes the connecting IP only for per-actor issue replacement |

## Rules for integrations

- Local editing and local Save are the default path.
- Lab backup is not an implicit side effect of local Save, Export, startup, or
  opening a project. A UI integration must show the destination, payload size,
  and consent affordance before sending it.
- A cloud integration must identify its endpoint and retention policy. It must
  preserve a local copy when remote storage is unavailable.
- The lab Worker uses the `spice_icproj_share_v1` request schema and rejects
  missing consent, unsupported schema, disallowed browser origins, oversized
  requests, or invalid project objects.

The public repository contains the Worker contract and deployable Pages shell;
the editor source that would add the consent dialog is in the private/external
source repository described in [`REPO_LAYOUT.md`](./REPO_LAYOUT.md).
