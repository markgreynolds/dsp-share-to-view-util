# Claude Project Context — dsp-share-to-view-util

This file provides context for continuing development of this project in a future Claude session. It covers the intent, prerequisites, lessons learned during development, and operational notes that are not obvious from reading the code alone.

---

## Project Intent

This project automates two SAP Datasphere operations that must be performed together and in sequence:

1. **Share local tables** from a source space (typically a file-space or staging space) to a target space (typically a consumption or analytics space)
2. **Create graphical view wrappers** in the target space for each shared table, with "Enable for Consumption" turned on (`@DataWarehouse.consumption.external: true`)

The tool exists because doing this manually for hundreds of tables through the Datasphere UI is impractical. The `--remove` mode reverses both operations in the correct order — views must be deleted before shares can be removed, otherwise the API returns a 500 error.

The single script is `share-to-view.js`. There are no other scripts in this project.

---

## Prerequisites and Environment

- **Runtime**: Node.js 20–24, npm 8–11
- **Key dependency**: `@sap/datasphere-cli` (npm package, version ~2026.x)
- **Authentication**: OAuth 2.0 Client Credentials flow using a Technical User credential created in Datasphere under System → Configuration → Security → OAuth Clients
- **Credential file**: `secrets.json` in the working directory (gitignored), containing `tenantUrl`, `client_id`, `client_secret`, `authorization_url`, `authorization_flow`
- **CLI cache**: Must be initialized once per machine per tenant with `datasphere config cache init` before the script will work

The `@sap/datasphere-cli` package is used as a Node.js module (not as a shell command). The entry point is:

```javascript
const datasphere = require("@sap/datasphere-cli");
const commands = await datasphere.getCommands(host);
```

Commands are invoked as async functions with option flags as object keys, e.g.:

```javascript
await commands["objects local-tables list"]({
  "--space": spaceId,
  "--select": "technicalName,status",
  "--top": "100",
  "--skip": "0",
});
```

---

## Lessons Learned

These are non-obvious behaviors discovered during development that any future contributor must understand.

### 1. The CLI credential cache silently overrides command-line credentials

The Datasphere CLI maintains a local credential cache (`datasphere config secrets show`). If this cache contains credentials from a previous session, the CLI will use those silently instead of the credentials supplied in `secrets.json` or on the command line. This causes 403 errors on every request with no indication that the wrong credentials are being used.

Fix: `datasphere config cache clean`, then reinitialize with `datasphere config cache init`.

The script detects this at startup by comparing the cached `client_id` and `tenantUrl` against the supplied values and prints a warning if they differ.

### 2. The CLI cache must be initialized before any commands are available

Without running `datasphere config cache init`, the CLI does not know what API commands exist. Attempting to call any command results in `commands["objects local-tables list"] is not a function`. This is not an authentication error — it is a missing service document error. The `secrets.json` file does not substitute for this step.

### 3. Concurrent `local-tables read` calls return incorrect results

The CLI has a shared internal state bug. When multiple `objects local-tables read` calls are made concurrently (e.g. via `Promise.all` or a concurrent pool), the responses are mixed up — one table's definition is returned under another table's name. All `local-tables read` calls must be made sequentially. View creates and view deletes do not have this problem and can safely run in parallel.

### 4. Use `--file-path` not `--input` for view create/update payloads

The CLI has a known bug where `--input` does not correctly set the request body for `objects views create` and `objects views update`. The workaround is to write the payload to a temporary JSON file and pass it via `--file-path`. The script does this automatically — it writes to `os.tmpdir()` and deletes the file after the call.

### 5. Sharing payload must contain only the `sharing` block

When updating table sharing, the API only accepts a payload containing the `sharing` block. Sending the full table definition causes a 400 error. The correct payload structure is:

```json
{
  "sharing": {
    "TABLENAME": {
      "targetSpaces": ["TARGET_SPACE"]
    }
  }
}
```

Other existing `targetSpaces` entries must be preserved — the script reads the current definition first, then merges in the new target space.

### 6. Shared tables do not appear in the target space table list

Calling `objects local-tables list` on the target space does not return shared-in tables. To discover which tables are shared to a target space, you must list tables from the source space and read each definition to check `sharing[tableName].targetSpaces`.

### 7. The `--accept` content-type header returns a richer but problematic structure

Reading a table definition with `--accept: application/vnd.sap.datasphere.object.content+json` returns CSN with additional annotations (`@EndUserText.label`, `@DataWarehouse.delta`, `@DataWarehouse.persistence.hdlf.*`, etc.) on element definitions. Copying these annotations into a view payload causes the CLI to reject it with "Failed to create an object from a JSON file or input string". The script reads table definitions without this header and strips element definitions down to structural fields only (`type`, `length`, `precision`, `scale`, `key`, `notNull`).

### 8. A propagation delay is needed after a new share

After successfully sharing a table, there is a short delay before the share is visible to the view creation API. If view creation is attempted immediately after sharing, it fails. The script waits 5 seconds after any new shares before proceeding to phase 2. This delay is skipped when all tables were already shared.

### 9. The `--force` flag is required to suppress the delete confirmation prompt

The CLI's `objects views delete` command prompts interactively for confirmation. In a non-interactive script this hangs. Pass `"--force": true` to suppress it.

### 10. 409 on share update does not mean failure

The API occasionally returns a 409 conflict on a share update even when the `sharing.targetSpaces` array read from the definition does not include the target space. This is an API inconsistency. The script treats 409 as success with a message "Already shared (confirmed by API)."

---

## Script Architecture — share-to-view.js

The script is structured as a single Node.js file with the following sections:

### Argument parsing
Uses Node.js built-in `parseArgs`. Auto-detects `secrets.json` in the working directory and reads `tenantUrl` from it if `--host` is not supplied.

### `runConcurrent(items, concurrency, fn)`
A concurrency-limited async pool. Used for parallel view creates and parallel view deletes. Do NOT use for `local-tables read` calls — see lesson 3 above.

### Phase 1 — Sharing (normal mode)
1. Lists all tables in source space (paginated, sequential)
2. Reads each table definition sequentially to check sharing status
3. For tables not yet shared, sends a share update sequentially
4. Tracks which tables were newly shared (`anyNewlyShared`)
5. If any new shares, waits 5 seconds
6. Re-reads all successful table definitions sequentially to get elements for phase 2

### Phase 2 — View creation (normal mode)
1. Lists existing views in target space
2. For each table, builds a graphical view payload via `buildViewDefinition`
3. Runs view creates/updates in parallel (concurrency 10)
4. Writes payload to a temp file, passes via `--file-path`

### Remove mode (`--remove`)
1. Lists all tables in source space
2. Deletes `_GV` views in parallel (concurrency 10, `--force: true`)
3. Unshares tables sequentially (each requires a `local-tables read`)

### `buildViewDefinition(viewName, tableName, sourceSpaceId, elements)`
Generates the full Datasphere graphical view payload including a `uiModel` JSON string containing a graph of UUID-keyed nodes representing the model, output, entity, context, diagram, symbols, and per-column element nodes. UUIDs are generated fresh on each call with `node:crypto` `randomUUID()`.

Key structure points:
- The source table is referenced as `"SOURCESPACE.TABLENAME"` (dotted string) in `from.ref`, not a two-element array
- `"@DataWarehouse.consumption.external": true` enables the view for consumption
- `editorSettings[viewName].editor.lastModifier` must be `"GRAPHICALVIEWBUILDER"` for Datasphere to render the view correctly in the graphical editor
- Element definitions in the view must only contain structural fields — no `@`-prefixed annotations

---

## Operational Notes

- **Space IDs are case-sensitive** — use the exact technical name as shown in Datasphere
- **`--dry-run` is always safe** — no API write calls are made
- **`--overwrite` replaces existing `_GV` views** — use with caution on views that may have been manually modified after creation
- **Concurrency is set to 10** — this is conservative. If the tenant has rate limiting issues, lower it; if performance is still too slow, it can be raised cautiously
- **The `secrets.json` file is gitignored** — every user must create their own from `secrets.json.example`
- **The CLI cache is per-machine** — every new machine or CI environment needs `datasphere config cache init` run before the script will work
- **View names follow the pattern `<TABLE_NAME>_GV`** — this is hardcoded; all views are graphical views with consumption enabled
