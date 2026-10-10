#!/usr/bin/env node
/**
 * Datasphere Share-to-View Utility
 *
 * Shares tables from a source space to a target space, then creates a graphical
 * view wrapper with "Enable for Consumption" for each shared table.
 *
 * Usage:
 *   node share-to-view.js --source-space <ID> --target-space <ID> [options]
 *
 * Authentication (pick one):
 *   --secrets-file <path>   Path to secrets.json with OAuth credentials
 *   --client-id / --client-secret / --authorization-url / --token-url
 *   --access-token <token>  Pre-obtained access token
 *
 * Options:
 *   --table <name>          Process only this table. Repeatable.
 *   --overwrite             Overwrite existing views (default: skip)
 *   --remove                Remove the _GV view then remove the share
 *   --dry-run               Show what would happen without making changes
 *   -h, --help              Show this help
 */

const datasphere = require("@sap/datasphere-cli");
const { parseArgs } = require("node:util");
const { randomUUID } = require("node:crypto");

const ARG_SPEC = {
  host: { type: "string" },
  "source-space": { type: "string" },
  "target-space": { type: "string" },
  "secrets-file": { type: "string" },
  "client-id": { type: "string" },
  "client-secret": { type: "string" },
  "authorization-url": { type: "string" },
  "token-url": { type: "string" },
  "access-token": { type: "string" },
  "authorization-flow": { type: "string" },
  table: { type: "string", multiple: true },
  overwrite: { type: "boolean", default: false },
  remove: { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
};

function printHelp() {
  console.log(`
Datasphere Share-to-View Utility

Shares tables from a source space to a target space, then creates a graphical
view wrapper with "Enable for Consumption" for each shared table.

Usage:
  node share-to-view.js --source-space <ID> --target-space <ID> [options]

Authentication (pick one):
  --secrets-file <path>         Path to secrets.json with OAuth credentials
  --client-id <id>
  --client-secret <secret>
  --authorization-url <url>
  --token-url <url>
  --access-token <token>        Pre-obtained access token

Options:
  --source-space <ID>           Space that owns the source tables (required)
  --target-space <ID>           Space to share tables into and create views (required)
  --table <name>                Technical name of table to process. Repeatable.
                                Omit to process all tables in source space.
  --overwrite                   Overwrite existing views (default: skip)
  --remove                      Delete the _GV view then remove the share
  --dry-run                     Show plan without making changes
  -h, --help                    Show this help

Examples:
  # Share all tables from NAR_QA_FILESPACE to NAR_QA, then create views
  node share-to-view.js \\
    --source-space NAR_QA_FILESPACE \\
    --target-space NAR_QA \\
    --secrets-file ./secrets.json

  # Process specific tables only
  node share-to-view.js \\
    --source-space NAR_QA_FILESPACE \\
    --target-space NAR_QA \\
    --table ORDERS \\
    --table CUSTOMERS

  # Preview without making changes
  node share-to-view.js \\
    --source-space NAR_QA_FILESPACE \\
    --target-space NAR_QA \\
    --dry-run

  # Remove views and unshare all tables
  node share-to-view.js \\
    --source-space NAR_QA_FILESPACE \\
    --target-space NAR_QA \\
    --remove
`);
}

function buildAuthOptions(args) {
  const opts = { "--host": args.host };
  if (args["secrets-file"]) opts["--secrets-file"] = args["secrets-file"];
  if (args["access-token"]) opts["--access-token"] = args["access-token"];
  if (args["client-id"]) opts["--client-id"] = args["client-id"];
  if (args["client-secret"]) opts["--client-secret"] = args["client-secret"];
  if (args["authorization-url"]) opts["--authorization-url"] = args["authorization-url"];
  if (args["token-url"]) opts["--token-url"] = args["token-url"];
  if (args["authorization-flow"]) opts["--authorization-flow"] = args["authorization-flow"];
  return opts;
}

function checkCacheMismatch(args) {
  let cached;
  try {
    const { execSync } = require("node:child_process");
    const output = execSync("datasphere config secrets show 2>/dev/null", { encoding: "utf8" });
    const parsed = JSON.parse(output);
    cached = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    return;
  }

  if (!cached) return;

  const warnings = [];

  if (args["client-id"] && cached.client_id && args["client-id"] !== cached.client_id) {
    warnings.push(`  --client-id  supplied: ${args["client-id"]}`);
    warnings.push(`               cached:   ${cached.client_id}`);
  }

  const cachedHost = (cached.tenantUrl || "").replace(/\/$/, "");
  const argHost = (args.host || "").replace(/\/$/, "");
  if (argHost && cachedHost && argHost !== cachedHost) {
    warnings.push(`  --host       supplied: ${argHost}`);
    warnings.push(`               cached:   ${cachedHost}`);
  }

  if (warnings.length) {
    console.warn("\nWARNING: CLI credential cache contains different values from your command-line arguments.");
    console.warn("The CLI may use the cached credentials instead of the ones you supplied.");
    console.warn("Run 'datasphere config cache clean' to clear the cache if this is unexpected.\n");
    warnings.forEach((w) => console.warn(w));
    console.warn("");
  }
}

function parseCommandResult(result) {
  if (!result) return [];
  if (Array.isArray(result) && result.length > 0 && typeof result[0] === "object") return result;
  if (typeof result === "object" && !Array.isArray(result)) return [result];
  const raw = Array.isArray(result) ? result.flat().join("") : String(result);
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [parsed];
  } catch {
    return raw;
  }
}

async function runConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Phase 1: sharing
// ---------------------------------------------------------------------------

async function listTables(commands, authOpts, spaceId) {
  const allTables = [];
  let skip = 0;
  const top = 100;

  while (true) {
    const result = await commands["objects local-tables list"]({
      ...authOpts,
      "--space": spaceId,
      "--select": "technicalName,status",
      "--top": String(top),
      "--skip": String(skip),
    });

    const parsed = parseCommandResult(result);
    if (!parsed || parsed.length === 0) break;
    allTables.push(...parsed);
    if (parsed.length < top) break;
    skip += top;
  }

  return allTables;
}

async function readTableDefinition(commands, authOpts, spaceId, technicalName) {
  const result = await commands["objects local-tables read"]({
    ...authOpts,
    "--space": spaceId,
    "--technical-name": technicalName,
  });

  if (result && typeof result === "object" && !Array.isArray(result)) return result;
  if (Array.isArray(result) && result.length > 0 && typeof result[0] === "object") return result[0];
  const raw = Array.isArray(result) ? result.flat().join("") : String(result);
  return JSON.parse(raw);
}

async function shareTable(commands, authOpts, spaceId, technicalName, targetSpaceId, dryRun) {
  console.log(`  Reading definition of ${technicalName}...`);
  const definition = await readTableDefinition(commands, authOpts, spaceId, technicalName);

  const sharing = definition.sharing || {};
  const tableSharing = sharing[technicalName] || {};
  const targetSpaces = tableSharing.targetSpaces || [];

  if (targetSpaces.includes(targetSpaceId)) {
    console.log(`  Already shared to ${targetSpaceId}.`);
    return { definition, newlyShared: false };
  }

  const payload = {
    sharing: {
      [technicalName]: {
        ...tableSharing,
        targetSpaces: [...targetSpaces, targetSpaceId],
      },
    },
  };

  if (dryRun) {
    console.log(`  [DRY RUN] Would share ${technicalName} to ${targetSpaceId}`);
    return { definition, newlyShared: false };
  }

  try {
    await commands["objects local-tables update"]({
      ...authOpts,
      "--space": spaceId,
      "--technical-name": technicalName,
      "--input": JSON.stringify(payload),
    });
    console.log(`  Shared ${technicalName} -> ${targetSpaceId}`);
  } catch (err) {
    if (err?.message?.includes("409")) {
      console.log(`  Already shared to ${targetSpaceId} (confirmed by API).`);
      return { definition, newlyShared: false };
    } else {
      throw err;
    }
  }

  return { definition, newlyShared: true };
}

async function deleteView(commands, authOpts, targetSpaceId, viewName, dryRun) {
  if (dryRun) {
    console.log(`  [DRY RUN] Would delete view ${viewName}`);
    return;
  }
  try {
    await commands["objects views delete"]({
      ...authOpts,
      "--space": targetSpaceId,
      "--technical-name": viewName,
      "--force": true,
    });
    console.log(`  Deleted view ${viewName}`);
  } catch (err) {
    if (err?.message?.includes("404") || err?.message?.includes("not found")) {
      console.log(`  View ${viewName} does not exist, skipping delete.`);
    } else {
      throw err;
    }
  }
}

async function unshareTable(commands, authOpts, spaceId, technicalName, targetSpaceId, dryRun) {
  console.log(`  Reading definition of ${technicalName}...`);
  const definition = await readTableDefinition(commands, authOpts, spaceId, technicalName);

  const sharing = definition.sharing || {};
  const tableSharing = sharing[technicalName] || {};
  const targetSpaces = tableSharing.targetSpaces || [];

  if (!targetSpaces.includes(targetSpaceId)) {
    console.log(`  Not shared to ${targetSpaceId}, nothing to remove.`);
    return;
  }

  const payload = {
    sharing: {
      [technicalName]: {
        ...tableSharing,
        targetSpaces: targetSpaces.filter((s) => s !== targetSpaceId),
      },
    },
  };

  if (dryRun) {
    console.log(`  [DRY RUN] Would remove share of ${technicalName} from ${targetSpaceId}`);
    return;
  }

  try {
    await commands["objects local-tables update"]({
      ...authOpts,
      "--space": spaceId,
      "--technical-name": technicalName,
      "--input": JSON.stringify(payload),
    });
    console.log(`  Removed share of ${technicalName} -> ${targetSpaceId}`);
  } catch (err) {
    if (err?.message?.includes("500")) {
      throw new Error(`Cannot unshare ${technicalName} — it may still be in use by an object in ${targetSpaceId}. Remove dependent objects first.`);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Phase 2: view creation
// ---------------------------------------------------------------------------

async function listExistingViews(commands, authOpts, spaceId) {
  const allViews = [];
  let skip = 0;
  const top = 100;

  while (true) {
    const result = await commands["objects views list"]({
      ...authOpts,
      "--space": spaceId,
      "--select": "technicalName",
      "--top": String(top),
      "--skip": String(skip),
    });

    const parsed = parseCommandResult(result);
    if (!parsed || parsed.length === 0) break;
    allViews.push(...parsed);
    if (parsed.length < top) break;
    skip += top;
  }

  return allViews.map((v) => v.technicalName || v);
}

function buildViewDefinition(viewName, tableName, sourceSpaceId, elements) {
  const columns = Object.entries(elements).map(([colName, colDef]) => {
    const col = { ref: [colName] };
    if (colDef.key) col.key = true;
    return col;
  });

  const viewElements = {};
  for (const [colName, colDef] of Object.entries(elements)) {
    const el = { type: colDef.type };
    if (colDef.length !== undefined) el.length = colDef.length;
    if (colDef.precision !== undefined) el.precision = colDef.precision;
    if (colDef.scale !== undefined) el.scale = colDef.scale;
    if (colDef.key) el.key = true;
    if (colDef.notNull) el.notNull = true;
    viewElements[colName] = el;
  }

  const modelId = randomUUID();
  const outputId = randomUUID();
  const entityId = randomUUID();
  const contextId = randomUUID();
  const diagramId = randomUUID();
  const outputSymbolId = randomUUID();
  const entitySymbolId = randomUUID();
  const assocSymbolId = randomUUID();

  const sourceElementIds = {};
  const outputElementIds = {};
  for (const colName of Object.keys(elements)) {
    sourceElementIds[colName] = randomUUID();
    outputElementIds[colName] = randomUUID();
  }

  const now = Date.now();
  const qualifiedTableName = `${sourceSpaceId}.${tableName}`;
  const uiContents = {};

  uiContents[modelId] = {
    classDefinition: "sap.cdw.querybuilder.Model",
    name: viewName, label: viewName,
    modificationDate: now, deploymentDate: 0, "#objectStatus": "0",
    output: outputId,
    nodes: { [outputId]: { name: viewName }, [entityId]: { name: qualifiedTableName } },
    contexts: { [contextId]: { name: sourceSpaceId } },
    diagrams: { [diagramId]: {} },
  };

  const outputElementsMap = {};
  for (const colName of Object.keys(elements)) {
    outputElementsMap[outputElementIds[colName]] = { name: colName };
  }
  uiContents[outputId] = {
    classDefinition: "sap.cdw.querybuilder.Output",
    name: viewName, type: "graphicView",
    isDeltaOutboundOn: false, isDeletionVector: false, isPinToMemoryEnabled: false,
    modificationDate: now, deploymentDate: 0, "#objectStatus": "0",
    elements: outputElementsMap,
  };

  uiContents[diagramId] = {
    classDefinition: "sap.cdw.querybuilder.ui.Diagram",
    symbols: {
      [outputSymbolId]: {},
      [entitySymbolId]: { name: "Entity Symbol 1" },
      [assocSymbolId]: {},
    },
  };

  uiContents[outputSymbolId] = {
    classDefinition: "sap.cdw.querybuilder.ui.OutputSymbol",
    x: 47, y: -20, width: 140, height: 40,
    object: outputId,
  };

  const entityElementsMap = {};
  for (const colName of Object.keys(elements)) {
    entityElementsMap[sourceElementIds[colName]] = { name: colName };
  }
  uiContents[entityId] = {
    classDefinition: "sap.cdw.querybuilder.Entity",
    name: qualifiedTableName, label: tableName,
    type: 9,
    isDeltaOutboundOn: false, isDeletionVector: false,
    isPersistenceExists: true, isPinToMemoryEnabled: false,
    isAllowConsumption: false, isHiddenInUi: false,
    modificationDate: 0, deploymentDate: 0, "#objectStatus": "1",
    alias: tableName,
    context: contextId,
    elements: entityElementsMap,
    successorNode: outputId,
  };

  uiContents[entitySymbolId] = {
    classDefinition: "sap.cdw.querybuilder.ui.EntitySymbol",
    name: "Entity Symbol 1",
    x: -163, y: -20, width: 160,
    displayName: "Entity Symbol 1",
    object: entityId,
  };

  uiContents[assocSymbolId] = {
    classDefinition: "sap.cdw.querybuilder.ui.AssociationSymbol",
    points: "-3,0 47,0", contentOffsetX: 5, contentOffsetY: 5,
    sourceSymbol: entitySymbolId,
    targetSymbol: outputSymbolId,
  };

  uiContents[contextId] = {
    classDefinition: "sap.cdw.commonmodel.Context",
    name: sourceSpaceId, label: sourceSpaceId,
    crossSpace: { schema: sourceSpaceId, space: sourceSpaceId },
  };

  const colNames = Object.keys(elements);
  colNames.forEach((colName, i) => {
    const colDef = elements[colName];
    uiContents[sourceElementIds[colName]] = {
      classDefinition: "sap.cdw.querybuilder.Element",
      name: colName, label: colName, newName: colName,
      indexOrder: i,
      length: colDef.length || 0,
      precision: colDef.precision || 0,
      scale: colDef.scale || 0,
      isMeasureBeforeAI: false, isMeasureAI: false,
      isNotNullBeforeAI: false, isKeyBeforeAI: false, isKeyAI: false,
      ...(colDef.key ? { isKey: true } : {}),
      ...(colDef.notNull ? { isNotNull: true } : {}),
      successorElement: outputElementIds[colName],
    };
  });

  colNames.forEach((colName, i) => {
    const colDef = elements[colName];
    uiContents[outputElementIds[colName]] = {
      classDefinition: "sap.cdw.querybuilder.Element",
      name: colName, label: colName, newName: colName,
      indexOrder: i,
      length: colDef.length || 0,
      precision: colDef.precision || 0,
      scale: colDef.scale || 0,
      isMeasureBeforeAI: false, isMeasureAI: false,
      isNotNullBeforeAI: false, isKeyBeforeAI: false, isKeyAI: false,
      ...(colDef.key ? { isKey: true } : {}),
      ...(colDef.notNull ? { isNotNull: true } : {}),
    };
  });

  return {
    definitions: {
      [viewName]: {
        kind: "entity",
        "@EndUserText.label": viewName,
        "@ObjectModel.modelingPattern": { "#": "DATA_STRUCTURE" },
        "@ObjectModel.supportedCapabilities": [{ "#": "DATA_STRUCTURE" }],
        "@DataWarehouse.consumption.external": true,
        elements: viewElements,
        query: {
          SELECT: {
            from: { ref: [qualifiedTableName], as: tableName },
            columns,
          },
        },
      },
      [sourceSpaceId]: {
        kind: "context",
        "@EndUserText.label": sourceSpaceId,
        "@DataWarehouse.space.schema": sourceSpaceId,
        "@DataWarehouse.space.name": sourceSpaceId,
      },
    },
    editorSettings: {
      [viewName]: {
        editor: {
          lastModifier: "GRAPHICALVIEWBUILDER",
          default: "GRAPHICALVIEWBUILDER",
        },
        uiModel: JSON.stringify({ contents: uiContents }),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let args;
  try {
    ({ values: args } = parseArgs({ options: ARG_SPEC, strict: false }));
  } catch (err) {
    console.error(`Argument error: ${err.message}`);
    process.exit(1);
  }

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (!args["secrets-file"]) {
    const fs = require("node:fs");
    if (fs.existsSync("./secrets.json")) {
      args["secrets-file"] = "./secrets.json";
      console.log("Detected secrets.json in current directory — using it for credentials.");
    }
  }

  if (!args.host && args["secrets-file"]) {
    try {
      const fs = require("node:fs");
      const secrets = JSON.parse(fs.readFileSync(args["secrets-file"], "utf8"));
      if (secrets.tenantUrl) args.host = secrets.tenantUrl;
    } catch {
      // handled below
    }
  }

  if (!args.host) {
    console.error("Error: --host is required (or set tenantUrl in --secrets-file)");
    process.exit(1);
  }

  if (!args["source-space"]) {
    console.error("Error: --source-space is required");
    process.exit(1);
  }

  if (!args["target-space"]) {
    console.error("Error: --target-space is required");
    process.exit(1);
  }

  const authOpts = buildAuthOptions(args);
  checkCacheMismatch(args);

  const sourceSpace = args["source-space"];
  const targetSpace = args["target-space"];
  const filterTables = args.table ? [].concat(args.table) : null;
  const overwrite = args.overwrite;
  const remove = args.remove;
  const dryRun = args["dry-run"];
  const CONCURRENCY = 10;

  const logs = [];
  datasphere.configure({ customLogger: { output: (...a) => logs.push(a.join(" ")) } });

  let commands;
  try {
    commands = await datasphere.getCommands(args.host);
  } catch (err) {
    console.error(`Failed to initialise CLI for host ${args.host}: ${err.message}`);
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // REMOVE mode: delete _GV views then unshare tables
  // -------------------------------------------------------------------------
  if (remove) {
    console.log(`\n=== Remove: deleting views and unsharing tables (${sourceSpace} -> ${targetSpace}) ===\n`);

    console.log(`Fetching tables from ${sourceSpace}...`);
    let allTables;
    try {
      allTables = await listTables(commands, authOpts, sourceSpace);
    } catch (err) {
      console.error(`Failed to list tables: ${err.message}`);
      if (logs.length) console.error(logs.join("\n"));
      process.exit(1);
    }

    if (!Array.isArray(allTables) || allTables.length === 0) {
      console.log("No local tables found in source space.");
      process.exit(0);
    }

    let tableNames = allTables.map((t) => t.technicalName || t);

    if (filterTables) {
      const missing = filterTables.filter((n) => !tableNames.includes(n));
      if (missing.length) console.warn(`\nWarning: tables not found in ${sourceSpace}: ${missing.join(", ")}`);
      tableNames = tableNames.filter((n) => filterTables.includes(n));
    }

    if (tableNames.length === 0) {
      console.log("\nNo matching tables to process.");
      process.exit(0);
    }

    console.log(`\n${dryRun ? "[DRY RUN] " : ""}Processing ${tableNames.length} table(s)...`);

    // Delete views in parallel (no reads involved)
    const deleteResults = await runConcurrent(tableNames, CONCURRENCY, async (tableName) => {
      const viewName = `${tableName}_GV`;
      try {
        await deleteView(commands, authOpts, targetSpace, viewName, dryRun);
        return { tableName, viewName, error: null };
      } catch (err) {
        return { tableName, viewName, error: err };
      }
    });

    // Unshare sequentially (each requires a read — concurrent reads return incorrect results)
    let successCount = 0;
    let errorCount = 0;

    for (const { tableName, viewName, error: deleteError } of deleteResults) {
      if (deleteError) {
        console.error(`  ${tableName}: error deleting view — ${deleteError.message}`);
        errorCount++;
        continue;
      }
      try {
        await unshareTable(commands, authOpts, sourceSpace, tableName, targetSpace, dryRun);
        console.log(`  ${tableName}: removed`);
        successCount++;
      } catch (err) {
        console.error(`  ${tableName}: error unsharing — ${err.message}`);
        errorCount++;
      }
    }

    console.log(`\nDone. ${successCount} removed, ${errorCount} errors.`);
    if (errorCount > 0) process.exit(1);
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // Phase 1: List and share tables
  // -------------------------------------------------------------------------
  console.log(`\n=== Phase 1: Sharing tables from ${sourceSpace} -> ${targetSpace} ===\n`);

  console.log(`Fetching tables from ${sourceSpace}...`);
  let allTables;
  try {
    allTables = await listTables(commands, authOpts, sourceSpace);
  } catch (err) {
    console.error(`Failed to list tables: ${err.message}`);
    if (logs.length) console.error(logs.join("\n"));
    process.exit(1);
  }

  if (!Array.isArray(allTables) || allTables.length === 0) {
    console.log("No local tables found in source space.");
    process.exit(0);
  }

  let tableNames = allTables.map((t) => t.technicalName || t);

  console.log(`\nTables in ${sourceSpace} (${tableNames.length} total):`);
  tableNames.forEach((name, i) => {
    const status = allTables[i]?.status ? ` [${allTables[i].status}]` : "";
    console.log(`  ${name}${status}`);
  });

  if (filterTables) {
    const missing = filterTables.filter((n) => !tableNames.includes(n));
    if (missing.length) console.warn(`\nWarning: tables not found in ${sourceSpace}: ${missing.join(", ")}`);
    tableNames = tableNames.filter((n) => filterTables.includes(n));
  }

  if (tableNames.length === 0) {
    console.log("\nNo matching tables to process.");
    process.exit(0);
  }

  console.log(`\n${dryRun ? "[DRY RUN] " : ""}Sharing ${tableNames.length} table(s):`);

  // Read all definitions in parallel to check sharing status
  // Note: reads must be sequential — concurrent CLI reads return incorrect results
  console.log(`Reading ${tableNames.length} table definition(s)...`);
  const readResults = [];
  for (const tableName of tableNames) {
    try {
      const definition = await readTableDefinition(commands, authOpts, sourceSpace, tableName);
      readResults.push({ tableName, definition, error: null });
    } catch (err) {
      readResults.push({ tableName, definition: null, error: err });
    }
  }

  const successfulTables = [];
  let shareSuccessCount = 0;
  let shareErrorCount = 0;
  let anyNewlyShared = false;

  for (const { tableName, definition, error } of readResults) {
    console.log(`\n- ${tableName}`);
    if (error) {
      console.error(`  Error reading definition: ${error.message}`);
      shareErrorCount++;
      continue;
    }

    const sharing = definition.sharing || {};
    const tableSharing = sharing[tableName] || {};
    const targetSpaces = tableSharing.targetSpaces || [];

    if (targetSpaces.includes(targetSpace)) {
      console.log(`  Already shared to ${targetSpace}.`);
      successfulTables.push(tableName);
      shareSuccessCount++;
      continue;
    }

    if (dryRun) {
      console.log(`  [DRY RUN] Would share ${tableName} to ${targetSpace}`);
      successfulTables.push(tableName);
      shareSuccessCount++;
      continue;
    }

    const payload = {
      sharing: {
        [tableName]: { ...tableSharing, targetSpaces: [...targetSpaces, targetSpace] },
      },
    };

    try {
      await commands["objects local-tables update"]({
        ...authOpts,
        "--space": sourceSpace,
        "--technical-name": tableName,
        "--input": JSON.stringify(payload),
      });
      console.log(`  Shared ${tableName} -> ${targetSpace}`);
      successfulTables.push(tableName);
      anyNewlyShared = true;
      shareSuccessCount++;
    } catch (err) {
      if (err?.message?.includes("409")) {
        console.log(`  Already shared to ${targetSpace} (confirmed by API).`);
        successfulTables.push(tableName);
        shareSuccessCount++;
      } else {
        console.error(`  Error: ${err.message}`);
        shareErrorCount++;
      }
    }
  }

  console.log(`\nPhase 1 done. ${shareSuccessCount} shared, ${shareErrorCount} errors.`);

  if (successfulTables.length === 0) {
    console.log("\nNo tables available for view creation.");
    process.exit(shareErrorCount > 0 ? 1 : 0);
  }

  if (anyNewlyShared) {
    console.log("\nWaiting for shares to propagate...");
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  // Read definitions for view creation (sequential — concurrent CLI reads return incorrect results)
  console.log(`\nReading ${successfulTables.length} table definition(s) for view creation...`);
  const elementResults = [];
  for (const tableName of successfulTables) {
    try {
      const definition = await readTableDefinition(commands, authOpts, sourceSpace, tableName);
      const elements = definition?.definitions?.[tableName]?.elements || {};
      elementResults.push({ tableName, elements, error: null });
    } catch (err) {
      elementResults.push({ tableName, elements: {}, error: err });
    }
  }

  const sharedDefinitions = {};
  for (const { tableName, elements, error } of elementResults) {
    if (error) {
      console.warn(`  Warning: could not re-read ${tableName}: ${error.message}`);
    } else {
      sharedDefinitions[tableName] = elements;
    }
  }

  // -------------------------------------------------------------------------
  // Phase 2: Create graphical views
  // -------------------------------------------------------------------------
  console.log(`\n=== Phase 2: Creating graphical views in ${targetSpace} ===\n`);

  const tablesToView = Object.keys(sharedDefinitions);

  console.log(`Checking existing views in ${targetSpace}...`);
  let existingViews;
  try {
    existingViews = await listExistingViews(commands, authOpts, targetSpace);
  } catch (err) {
    console.error(`Failed to list existing views: ${err.message}`);
    process.exit(1);
  }

  console.log(`\n${dryRun ? "[DRY RUN] " : ""}Creating views for ${tablesToView.length} table(s) (parallel)...`);

  let viewSuccessCount = 0;
  let viewSkippedCount = 0;
  let viewErrorCount = 0;

  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  const viewResults = await runConcurrent(tablesToView, CONCURRENCY, async (tableName) => {
    const viewName = `${tableName}_GV`;
    const elements = sharedDefinitions[tableName];

    if (existingViews.includes(viewName) && !overwrite) {
      return { tableName, viewName, status: "skipped" };
    }

    if (Object.keys(elements).length === 0) {
      return { tableName, viewName, status: "error", message: `No columns found in definition for ${tableName}` };
    }

    const viewDef = buildViewDefinition(viewName, tableName, sourceSpace, elements);

    if (dryRun) {
      return { tableName, viewName, status: "dry-run", columns: Object.keys(elements).length };
    }

    try {
      const tmpFile = path.join(os.tmpdir(), `${viewName}_input.json`);
      fs.writeFileSync(tmpFile, JSON.stringify(viewDef));
      const cmd = existingViews.includes(viewName) ? "objects views update" : "objects views create";
      await commands[cmd]({
        ...authOpts,
        "--space": targetSpace,
        "--technical-name": viewName,
        "--file-path": tmpFile,
      });
      fs.unlinkSync(tmpFile);
      return { tableName, viewName, status: "created", columns: Object.keys(elements).length };
    } catch (err) {
      return { tableName, viewName, status: "error", message: err.message };
    }
  });

  for (const r of viewResults) {
    switch (r.status) {
      case "skipped":
        console.log(`  ${r.viewName}: skipped (already exists)`);
        viewSkippedCount++;
        break;
      case "dry-run":
        console.log(`  ${r.viewName}: [DRY RUN] would create (${r.columns} columns)`);
        viewSuccessCount++;
        break;
      case "created":
        console.log(`  ${r.viewName}: created (${r.columns} columns)`);
        viewSuccessCount++;
        break;
      case "error":
        console.error(`  ${r.viewName}: error — ${r.message}`);
        viewErrorCount++;
        break;
    }
  }

  console.log(`\nPhase 2 done. ${viewSuccessCount} created, ${viewSkippedCount} skipped, ${viewErrorCount} errors.`);

  const totalErrors = shareErrorCount + viewErrorCount;
  if (totalErrors > 0) process.exit(1);
}

main();
