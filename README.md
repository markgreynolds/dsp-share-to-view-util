# Datasphere Share-to-View Utility

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)

A Node.js command-line tool that automates two related SAP Datasphere operations in a single command:

1. **Share tables** from a source space to a target space
2. **Create graphical view wrappers** in the target space for each shared table, with "Enable for Consumption" turned on

This is useful when a file-space or staging space contains raw tables that need to be made available for reporting or analytics in a separate consumption space. Running the tool once handles both the sharing and the view layer, including skipping tables that are already shared and views that already exist.

The tool also supports a `--remove` mode that reverses the process: it deletes the graphical views first, then removes the sharing — in the correct order to avoid dependency errors.

---

## Table of Contents

- [Prerequisites](#prerequisites)
  - [Node.js and npm](#nodejs-and-npm)
  - [SAP Datasphere CLI](#sap-datasphere-cli)
  - [Git](#git)
  - [Clone the Repository](#clone-the-repository)
  - [Install Dependencies](#install-dependencies)
- [Setup](#setup)
  - [1. Create an OAuth Client in SAP Datasphere](#1-create-an-oauth-client-in-sap-datasphere)
  - [2. Configure secrets.json](#2-configure-secretsjson)
  - [3. Initialize the CLI Credential Cache](#3-initialize-the-cli-credential-cache)
- [Running the Tool](#running-the-tool)
  - [Options Reference](#options-reference)
  - [Examples](#examples)
  - [View Naming Convention](#view-naming-convention)
  - [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Node.js and npm

The following versions are required:

- **Node.js**: version 20 or later, up to version 24
- **npm**: version 8 or later, up to version 11

npm is distributed with Node.js — when you install Node.js, npm is installed automatically. Download the Node.js installer from [nodejs.org](https://nodejs.org).

Verify that both are installed and check their versions:

```bash
node -v
npm -v
```

If both are installed, the current version numbers will appear. If you receive an error, they have not been installed yet.

### SAP Datasphere CLI

The Datasphere CLI must be installed globally on your system. It is used both by this tool internally and for credential cache management operations.

```bash
npm install -g @sap/datasphere-cli
```

> **Note:** To update the CLI to the latest version at any time, run the same command again.

Verify the installation was successful:

```bash
datasphere --version
```

The CLI maintains a local credential cache that can interfere with credentials supplied on the command line or in `secrets.json`. If you receive unexpected 403 errors, clear the cache:

```bash
datasphere config cache clean
```

The tool will warn at startup if the cached credentials differ from the ones you have configured.

### Git

Git is required to clone the repository.

```bash
git --version
```

If Git is not installed, download it from [https://git-scm.com](https://git-scm.com).

### Clone the Repository

```bash
git clone <repository-url>
cd dsp-share-to-view-util
```

### Install Dependencies

```bash
npm install
```

This installs the `@sap/datasphere-cli` package into `node_modules/`. No other dependencies are required.

---

## Setup

### 1. Create an OAuth Client in SAP Datasphere

The tool authenticates to Datasphere using OAuth 2.0 Client Credentials. This requires creating an API credential in your Datasphere tenant.

In Datasphere, navigate to **System → Configuration → Security → OAuth Clients** and create a new entry with the following settings:

- **OAuth Client Name**: any descriptive name, e.g. `dsp-share-to-view-util`
- **Purpose**: `API Access`
- **Type**: `Technical User`

> **Important:** The type must be set to **Technical User**. The other available types ("Interactive Usage" and "API Access" without Technical User) do not have the permissions required to perform space-level API operations such as sharing tables and creating views.

After saving, Datasphere will display the generated **Client ID** and **Client Secret**. Copy both values — the secret is only shown once.

You will also need:

- The **Token URL** for your tenant's identity provider, in the form:
  `https://<your-tenant>.authentication.<region>.hana.ondemand.com/oauth/token`
- Your **Tenant URL**, in the form:
  `https://<your-tenant>.<region>.hcs.cloud.sap`

### 2. Configure secrets.json

The tool looks for a `secrets.json` file in the directory where you run the command. If found, it is used automatically — no need to pass credential flags on every command.

Copy the example file and fill in your values:

```bash
cp secrets.json.example secrets.json
```

Edit `secrets.json`:

```json
{
  "tenantUrl": "https://your-tenant.eu10.hcs.cloud.sap",
  "client_id": "sb-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx|client!bXXXX",
  "client_secret": "your-client-secret-here",
  "authorization_url": "https://your-tenant.authentication.eu10.hana.ondemand.com/oauth/token",
  "authorization_flow": "client_credentials"
}
```

| Field | Description |
|---|---|
| `tenantUrl` | The base URL of your Datasphere tenant |
| `client_id` | OAuth Client ID from the credential you created |
| `client_secret` | OAuth Client Secret from the credential you created |
| `authorization_url` | Token endpoint URL for your tenant's identity provider |
| `authorization_flow` | Must be `client_credentials` for machine-to-machine access |

> **Security note:** `secrets.json` is listed in `.gitignore` and will not be committed to the repository. Never commit credentials to source control.

### 3. Initialize the CLI Credential Cache

**This step is mandatory. The tool will not work without it.**

The `secrets.json` file handles authentication at runtime, but it does not replace this step. The Datasphere CLI operates by downloading a service document from your tenant — a complete map of every available API endpoint and command. This map is stored in a local cache. Without it, the CLI has no knowledge of what commands exist, and the script will immediately fail with an error like `commands["objects local-tables list"] is not a function`, regardless of whether `secrets.json` is correctly configured.

This command only needs to be run once per machine per tenant. If you ever clear the cache with `datasphere config cache clean`, you must run it again before the tool will work.

```bash
datasphere config cache init \
  --host https://your-tenant.eu10.hcs.cloud.sap \
  --client-id "your-client-id" \
  --client-secret "your-client-secret" \
  --authorization-flow client_credentials
```

Use the same `client_id` and `client_secret` values from your `secrets.json`. The `--host` value is your `tenantUrl`.

---

## Running the Tool

The general command form is:

```bash
node share-to-view.js \
  --source-space <SOURCE_SPACE_ID> \
  --target-space <TARGET_SPACE_ID> \
  [options]
```

If `secrets.json` is present in the current directory, it is detected automatically and used for authentication. The tenant URL is also read from `secrets.json`, so `--host` does not need to be supplied separately.

### Options Reference

| Option | Description |
|---|---|
| `--source-space <ID>` | The space that owns the source tables (required) |
| `--target-space <ID>` | The space to share tables into and create views (required) |
| `--table <name>` | Process only this table. Can be repeated for multiple tables. Omit to process all tables. |
| `--overwrite` | Overwrite existing `_GV` views (default: skip tables that already have a view) |
| `--remove` | Delete the `_GV` view and remove the share for each table |
| `--dry-run` | Show what would be done without making any changes |
| `--secrets-file <path>` | Path to a secrets file if not using `secrets.json` in the current directory |
| `--access-token <token>` | Use a pre-obtained Bearer token instead of OAuth credentials |
| `-h, --help` | Show help |

---

### Examples

#### Preview all tables without making changes

Use `--dry-run` to see exactly what the tool would share and create before committing to it. This is a good first step when running against a new space.

```bash
node share-to-view.js \
  --source-space NAR_QA_FILESPACE \
  --target-space NAR_QA \
  --dry-run
```

The output will list every table in the source space, show which ones would be shared, and show which `_GV` views would be created — without touching anything.

---

#### Share all tables and create views for all of them

Omitting `--table` processes every local table found in the source space. Tables already shared are detected and skipped automatically. Views that already exist are also skipped unless `--overwrite` is passed.

```bash
node share-to-view.js \
  --source-space NAR_QA_FILESPACE \
  --target-space NAR_QA
```

---

#### Process a single specific table

Use `--table` to limit the operation to one table by its technical name.

```bash
node share-to-view.js \
  --source-space NAR_QA_FILESPACE \
  --target-space NAR_QA \
  --table ORDERS
```

---

#### Process several specific tables

`--table` can be repeated to name multiple tables. Only those tables will be shared and have views created.

```bash
node share-to-view.js \
  --source-space NAR_QA_FILESPACE \
  --target-space NAR_QA \
  --table ORDERS \
  --table CUSTOMERS \
  --table PRODUCTS
```

---

#### Overwrite existing views

By default the tool skips any table whose `_GV` view already exists in the target space. Use `--overwrite` to replace them. This is useful after a table schema change where the view needs to be regenerated.

```bash
node share-to-view.js \
  --source-space NAR_QA_FILESPACE \
  --target-space NAR_QA \
  --overwrite
```

To overwrite the view for a single table:

```bash
node share-to-view.js \
  --source-space NAR_QA_FILESPACE \
  --target-space NAR_QA \
  --table ORDERS \
  --overwrite
```

---

#### Preview a remove operation before executing it

Before removing shares and deleting views, use `--dry-run` with `--remove` to confirm exactly what would be affected.

```bash
node share-to-view.js \
  --source-space NAR_QA_FILESPACE \
  --target-space NAR_QA \
  --remove \
  --dry-run
```

---

#### Remove all views and unshare all tables

`--remove` deletes the `_GV` view in the target space first, then removes the sharing from the source table. The order matters — attempting to unshare a table that has a dependent view will fail with a 500 error.

```bash
node share-to-view.js \
  --source-space NAR_QA_FILESPACE \
  --target-space NAR_QA \
  --remove
```

---

#### Remove views and unshare specific tables only

```bash
node share-to-view.js \
  --source-space NAR_QA_FILESPACE \
  --target-space NAR_QA \
  --remove \
  --table ORDERS \
  --table CUSTOMERS
```

---

### View naming convention

Every view created by this tool is named `<TABLE_NAME>_GV`. For example, a shared table named `ORDERS` will produce a view named `ORDERS_GV` in the target space. The `_GV` suffix stands for Graphical View. All views are created as graphical views with **Enable for Consumption** turned on, making them immediately available to SAP Analytics Cloud and other consuming tools.

---

### Troubleshooting

**403 errors on every request**

The Datasphere CLI caches credentials locally and will silently use the cached values instead of the ones in `secrets.json`. If the cache contains credentials from a previous session or a different tenant, all requests will fail with 403.

Clear the cache and reinitialize:

```bash
datasphere config cache clean
datasphere config cache init \
  --host https://your-tenant.eu10.hcs.cloud.sap \
  --client-id "your-client-id" \
  --client-secret "your-client-secret" \
  --authorization-flow client_credentials
```

The tool will also print a warning at startup if it detects that the cached client ID or host differs from the values in `secrets.json`.

**`commands["objects local-tables list"] is not a function`**

The CLI cache has not been initialized for this tenant. Run the `datasphere config cache init` command shown above.

**500 error when removing a share**

A 500 response when unsharing a table means the table is still referenced by an object in the target space other than the `_GV` view managed by this tool. Remove or update those dependent objects before retrying.
