# SaaS CLI Automation & Tenant Management System — Master Plan

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        CURRENT STATE                                    │
│                                                                         │
│  vision-init.js  ───  FIREBASE_CONFIG (hardcoded)                       │
│                       apiKey: "AIzaSyCfqb7u3Es7rq..."                   │
│                       projectId: "erp-website-38fe1"                     │
│                                                                         │
│  Firebase project  ─── erp-website-38fe1 (single hardcoded project)     │
│                                                                         │
│  Tenancy model     ─── single-tenant SaaS (one Firestore doc controls   │
│                        subscription, but everyone shares one Firebase   │
│                        project — no true tenant isolation)              │
└─────────────────────────────────────────────────────────────────────────┘

                              ▼  TRANSFORM  ▼

┌─────────────────────────────────────────────────────────────────────────┐
│                        TARGET ARCHITECTURE                              │
│                                                                         │
│  ┌─────────────────────┐      ┌──────────────────────────────────────┐ │
│  │  External Vault      │      │  ERP Source Repo (THIS repo)         │ │
│  │  ../nazamly-clients- │      │                                      │ │
│  │  vault/              │      │  vision-init.js → PLACEHOLDER config │ │
│  │                      │      │    apiKey: "{{FIREBASE_API_KEY}}"    │ │
│  │  elnour/.env         │      │    projectId: "{{FIREBASE_PROJECT_ID}}"│ │
│  │  alhilal/.env        │      │    ... (6 placeholder variables)     │ │
│  │  altawfik/.env       │      │                                      │ │
│  │  ...                 │      │  Each HTML page references the       │ │
│  │                      │      │  SAME vision-init.js — it gets       │ │
│  │  Each .env contains: │      │  injected at deploy time.            │ │
│  │  - CLIENT_ID         │      │                                      │ │
│  │  - ADMIN_EMAIL       │      └──────────────────────────────────────┘ │
│  │  - ADMIN_PASSWORD    │                                               │
│  │  - FIREBASE_API_KEY  │      ┌──────────────────────────────────────┐ │
│  │  - FIREBASE_AUTH_    │      │  Per-Client Firebase Projects        │ │
│  │    DOMAIN            │      │                                      │ │
│  │  - FIREBASE_PROJECT_ │      │  Client "elnour" → elnour-erp-abc12  │ │
│  │    ID                │      │  Client "alhilal" → alhilal-erp-x7f3 │ │
│  │  - FIREBASE_STORAGE_ │      │  Client "altawfik" → altawfik-erp-d9 │ │
│  │    BUCKET            │      │                                      │ │
│  │  - FIREBASE_MSG_     │      │  Each has:                           │ │
│  │    SENDER_ID         │      │  - Firebase Auth (employee accounts) │ │
│  │  - FIREBASE_APP_ID   │      │  - Firestore (orders, inventory, …)  │ │
│  │  - CLIENT_BRAND      │      │  - Firebase Hosting (own domain)     │ │
│  │  - CLIENT_DOMAIN     │      │  - Own /system_status/config doc     │ │
│  │  - SUBSCRIPTION_     │      │  - Own /system/config doc            │ │
│  │    MONTHS            │      │  - Own /employees collection         │ │
│  │                      │      └──────────────────────────────────────┘ │
│  └─────────────────────┘                                               │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  CLI Toolkit (Node.js)                                           │   │
│  │                                                                  │   │
│  │  create-client.js   Interactive tenant creation + DB seeding     │   │
│  │  deploy.js           Build + deploy one or all tenants            │   │
│  │  backup.js           Export Firestore data per client             │   │
│  │  audit.js            Read-only status inspector for all tenants   │   │
│  │  destroy.js          Controlled tenant decommissioning (dry-run)  │   │
│  │                                                                  │   │
│  │  lib/                Shared utilities                             │   │
│  │    vault.js          .env read/write/encrypt helpers              │   │
│  │    firebase-admin.js Admin SDK bootstrap (per-client)             │   │
│  │    injection.js      Replace placeholders → output build          │   │
│  │    deployer.js       Firebase Hosting deployment logic            │   │
│  │    logger.js         Structured JSON logging                      │   │
│  │    validator.js      .env validation + Firebase connectivity test │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Firebase SDK Decision: Admin SDK vs Web SDK

### CLI tooling: Firebase Admin SDK (required)

| Factor | Admin SDK (Node.js) | Web SDK (compat) |
|--------|---------------------|-------------------|
| Programmatic user creation (`auth.createUser()`) | ✅ YES — this is how we seed admin accounts | ❌ NO — requires client-side interaction |
| Server-side Firestore writes without auth UI | ✅ YES — direct service-account access | ❌ NO — needs browser-based auth |
| Read/write to any collection without rules | ✅ YES — bypasses security rules | ❌ NO — subject to Firestore security rules |
| Environment: CLI/Node.js script | ✅ Designed for this | ❌ Browser-only API |
| `.env` / non-browser config | ✅ Standard Node pattern | ❌ Loaded via script tags in HTML |
| Service account key auth | ✅ `GOOGLE_APPLICATION_CREDENTIALS` or inline JSON | ❌ API key auth (public) |
| Deployment to Firebase Hosting | ✅ Via `firebase-tools` CLI (shell) | ❌ N/A |

**Decision:** The CLI scripts (`create-client.js`, `deploy.js`, `backup.js`, `audit.js`, `destroy.js`) **must** use the **Firebase Admin SDK** (`firebase-admin` npm package) for all Firestore operations (seeding, backup, inspection). For the deployment step that pushes to Firebase Hosting, we shell out to `firebase-tools` CLI (`npx firebase deploy`).

The **Web SDK** (`firebase-app-compat`, etc.) remains exclusively in the **browser HTML pages** — unchanged, except that the Firebase config values get injected from `.env` at build time rather than being hardcoded.

---

## 3. Proposed Business, Technical & Security Enhancements

### Enhancement 1: Automated Pre-Deployment Backups
**Type:** Technical / Disaster Recovery  
**Why:** Before every deployment (single or --all), the CLI should snapshot Firestore data for that tenant. A failed deploy or corrupted Firestore data during seeding is recoverable only if you have a recent export.  
**Implementation:**
- New script: `backup.js` (or a `--backup` flag on `deploy.js`)
- Uses Admin SDK to export all Firestore collections to a timestamped JSON file in `../nazamly-clients-vault/<client-id>/backups/`
- `deploy.js --all` always runs backup before deploying each client
- A `restore.js` companion script reads a backup JSON and writes it back to Firestore (with confirmation prompts)

### Enhancement 2: Structured CLI Logging & Audit Trail
**Type:** Operational / Compliance  
**Why:** Every CLI action (tenant creation, deploy, data wipe) is a high-stakes operation. Currently there is no log. A JSON-based audit log enables tracing "who ran what and when" and provides evidence for client disputes.  
**Implementation:**
- `lib/logger.js` — writes structured JSON lines to `../nazamly-clients-vault/_audit/audit.log`
- Each entry: `{ timestamp, action, clientId, user (OS username), result, durationMs, error (if any) }`
- The `audit.js` script can filter this log by client, action, or date range and print a readable report
- Optional: hash-chain entries (SHA-256 of previous line + current line) for tamper evidence

### Enhancement 3: Environment Segregation (Dev / Staging / Production)
**Type:** Technical / Quality Assurance  
**Why:** Deploying directly to a client's production Firebase project from your local machine is risky. A "staging" tenant mode lets you validate the full pipeline on a test Firebase project before touching production.  
**Implementation:**
- Each client `.env` gains an optional `DEPLOY_TARGET` field: `production` (default) or `staging`
- The CLI supports a `--staging` flag that writes to a separate staging Firebase project (e.g., `elnour-erp-staging` instead of `elnour-erp-prod`)
- `create-client.js` gains an optional `--staging` mode that generates TWO `.env` files: `.env.production` and `.env.staging`
- `deploy.js` respects `DEPLOY_TARGET` — `--target staging` deploys to the staging project; omitting it deploys to production

### Enhancement 4: Rollback Mechanism
**Type:** Technical / Disaster Recovery  
**Why:** If a deployment introduces a breaking bug, you need a one-command way to return to the previous version. Firebase Hosting supports version history, but the CLI should automate this.  
**Implementation:**
- `deploy.js` records each deploy in a `deploy-history.json` inside the client's vault folder: `{ timestamp, hostingVersion, backupFile, commitHash }`
- `rollback.js` (or `deploy.js --rollback <client-id>`) reads the previous deploy entry, reverts Firebase Hosting to the prior release, and optionally restores the Firestore backup
- Requires that deployments are done via Firebase Hosting channels or that we capture the hosting release name after each deploy

### Enhancement 5: Client-Specific Branding Injection
**Type:** Business / Product  
**Why:** Currently `window.CLIENT_BRAND` is fetched from Firestore at runtime (`/system/config`). This means the page first loads with a generic "نظام الإدارة" title, then flickers to the real brand. A better approach: inject the brand name at build time so it's immediately correct.  
**Implementation:**
- Add `CLIENT_BRAND` to the `.env` file
- During deployment, `lib/injection.js` replaces `{{CLIENT_BRAND}}` in vision-init.js (and page `<title>` tags) with the real brand name
- The Firestore `brandName` becomes a fallback override (runtime changeable without redeploy)
- Also inject: `CLIENT_DOMAIN` for the WhatsApp link on `suspended.html`, `SUPPORT_PHONE` for client-specific contact

### Enhancement 6: Tenant Health Dashboard
**Type:** Operational / Monitoring  
**Why:** Once you have 5+ tenants, you can't manually check each one's subscription status, expiry dates, and deploy versions. A single read-only script gives a bird's-eye view.  
**Implementation:**
- `audit.js --health` iterates all clients in the vault, connects to each Firebase project with Admin SDK, and prints a table:
  - Client ID | Brand | isActive | Days Remaining | Employees Count | Products Count | Last Deploy Date | Staging Deployed?
- Green/Yellow/Red color coding for expiry thresholds
- Optionally exports as CSV for external reporting

### Enhancement 7: Secrets Encryption at Rest
**Type:** Security  
**Why:** The `.env` files contain Firebase API keys, admin passwords, and service account keys in plaintext on disk. Anyone with filesystem access to the vault can read them.  
**Implementation:**
- `lib/vault.js` supports optional AES-256-GCM encryption of `.env` files
- A master passphrase (stored in a single `.vault-key` file, or provided interactively) encrypts/decrypts all client `.env` files
- `create-client.js` encrypts by default; all other scripts decrypt on read
- The `.vault-key` file itself is gitignored and stored only on the DevOps machine
- This is **optional** — the system works without encryption for development convenience

---

## 4. Micro-Phase Implementation Breakdown

Each phase is designed to be independently testable and small enough to fit within token/request limits.

### Phase 0: Repository Scaffolding
| Step | File | Action | Description |
|------|------|--------|-------------|
| 0.1 | `package.json` | CREATE | Root `package.json` with scripts: `create-client`, `deploy`, `backup`, `audit`, `destroy`. Dependencies: `firebase-admin`, `dotenv`, `inquirer` (or `prompts`), `chalk`, `commander` |
| 0.2 | `.gitignore` | EDIT | Add `../nazamly-clients-vault/`, `.env*`, service account JSON keys, `node_modules/` |
| 0.3 | `cli/` directory | CREATE | Create `cli/` folder with empty placeholder files for each script |

### Phase 1: Vault Library & .env Schema
| Step | File | Action | Description |
|------|------|--------|-------------|
| 1.1 | `cli/lib/vault.js` | CREATE | `readEnv(clientId)`, `writeEnv(clientId, data)`, `listClients()`, `clientExists(clientId)`, `getVaultPath(clientId)`. All paths relative to `../nazamly-clients-vault/<clientId>/` |
| 1.2 | `cli/lib/validator.js` | CREATE | `validateEnv(data)` — checks all 6 Firebase keys are non-empty + follow expected format patterns. `testFirebaseConnection(config)` — uses Admin SDK to attempt a Firestore read. `validateClientId(id)` — alphanumeric + hyphens, max 30 chars |
| 1.3 | `cli/lib/logger.js` | CREATE | `init()`, `logAction(action, clientId, details)`, `logError(action, clientId, error)`. Writes JSONL to vault `_audit/` directory. Each line: `{isoTimestamp, action, clientId, osUser, result, durationMs, metadata}` |

### Phase 2: Interactive Client Creator (create-client.js)
| Step | File | Action | Description |
|------|------|--------|-------------|
| 2.1 | `cli/create-client.js` | CREATE | Interactive prompts using `inquirer`: ① Client ID ② Brand Name (Arabic) ③ Admin Email ④ Admin Password ⑤ Subscription Duration (months: 1/3/6/12) ⑥ API Key ⑦ Auth Domain ⑧ Project ID ⑨ Storage Bucket ⑩ Messaging Sender ID ⑪ App ID |
| 2.2 | `cli/lib/firebase-admin.js` | CREATE | `getAdminApp(clientId)` — initializes (caches) an Admin SDK instance from the client's `.env`. `seedDatabase(clientId, data)` — writes to Firestore. `destroyApp(clientId)` — cleanup |
| 2.3 | `cli/create-client.js` | CONTINUE | After collecting input: (a) validate all fields via validator.js, (b) write `.env` to vault via vault.js, (c) test Firebase connectivity, (d) call seeder |

### Phase 3: Database Seeding Logic
| Step | File | Action | Description |
|------|------|--------|-------------|
| 3.1 | `cli/lib/seeder.js` | CREATE | `seedSuperAdmin(adminApp, config)` — creates the fixed super_admin Firebase Auth account (YOUR credentials, hardcoded in seeder config) and writes `/employees/{uid}` doc with `role: 'super_admin'` |
| 3.2 | `cli/lib/seeder.js` | CONTINUE | `seedClientAdmin(adminApp, config)` — creates the client's admin account from `.env` values (`ADMIN_EMAIL`, `ADMIN_PASSWORD`), writes `/employees/{uid}` doc with `role: 'admin'` |
| 3.3 | `cli/lib/seeder.js` | CONTINUE | `seedSystemConfig(adminApp, config)` — writes `/system/config` Firestore doc: `{ brandName, allowedEmails: [ADMIN_EMAIL], settings: {} }` |
| 3.4 | `cli/lib/seeder.js` | CONTINUE | `seedSubscription(adminApp, config)` — writes `/system_status/config`: `{ isActive: true, startDate: now, endDate: now + SUBSCRIPTION_MONTHS, subscriptionHistory: [initial entry], usageCaps: { maxEmployees: 5, maxProducts: 200 } }` |
| 3.5 | `cli/lib/seeder.js` | CONTINUE | `seedAll(adminApp, config)` — orchestrates 3.1–3.4 in order, logs each step, returns summary |

### Phase 4: Template Injection Engine
| Step | File | Action | Description |
|------|------|--------|-------------|
| 4.1 | `core/vision-init.js` | EDIT | Replace hardcoded `FIREBASE_CONFIG` values with placeholders: `{{FIREBASE_API_KEY}}`, `{{FIREBASE_AUTH_DOMAIN}}`, `{{FIREBASE_PROJECT_ID}}`, `{{FIREBASE_STORAGE_BUCKET}}`, `{{FIREBASE_MSG_SENDER_ID}}`, `{{FIREBASE_APP_ID}}`. Also add `{{CLIENT_BRAND}}` for the default brand |
| 4.2 | `suspended.html` | EDIT | Replace hardcoded WhatsApp number with `{{SUPPORT_PHONE}}` placeholder |
| 4.3 | `*.html` (all pages) | EDIT | Replace `<title>…Nazamly</title>` with `<title>…{{CLIENT_BRAND}}</title>` in all 12 HTML files |
| 4.4 | `cli/lib/injection.js` | CREATE | `injectConfig(sourceDir, buildDir, envData)` — reads each `.html` and `.js` file from `sourceDir/`, replaces all `{{PLACEHOLDER}}` tokens with values from the env object, writes output to `buildDir/<clientId>/`. Uses regex: `/{{(\w+)}}/g` |
| 4.5 | `cli/lib/injection.js` | CONTINUE | Add validation: after injection, scan build output for any remaining `{{...}}` tokens — if any are found, fail with a list of unreplaced placeholders |

### Phase 5: Deployment Engine (deploy.js)
| Step | File | Action | Description |
|------|------|--------|-------------|
| 5.1 | `cli/lib/deployer.js` | CREATE | `deployToHosting(clientId, buildDir, envData)` — (a) copies build into a temporary Firebase project directory, (b) generates a `firebase.json` and `.firebaserc` pointing to the client's project ID, (c) shells out to `npx firebase deploy --only hosting` |
| 5.2 | `cli/lib/deployer.js` | CONTINUE | `recordDeploy(clientId, details)` — appends to `deploy-history.json` in the client vault folder: `{ timestamp, buildDir, hostingTarget, commitHash, backupFile }` |
| 5.3 | `cli/deploy.js` | CREATE | CLI entry point using `commander`: `--client <id>` deploys one; `--all` deploys all sequentially; `--staging` targets staging env; `--skip-backup` for speed; `--dry-run` injects but doesn't deploy |
| 5.4 | `cli/deploy.js` | CONTINUE | `--all` flow: (1) list all clients, (2) backup each, (3) inject each, (4) deploy each. Show progress bar. On any failure, stop and report which client failed — do not continue blindly |

### Phase 6: Backup & Restore
| Step | File | Action | Description |
|------|------|--------|-------------|
| 6.1 | `cli/lib/backup.js` | CREATE | `exportFirestore(clientId)` — uses Admin SDK to list all collections, export each document to JSON, write timestamped file to vault `backups/` folder |
| 6.2 | `cli/backup.js` | CREATE | CLI: `--client <id>` or `--all`. Reports file sizes and document counts per collection |
| 6.3 | `cli/lib/restore.js` | CREATE | `importFirestore(clientId, backupFile)` — reads a backup JSON, writes all documents back to Firestore. **Destructive** — requires explicit `--confirm` flag + interactive prompt |
| 6.4 | `cli/restore.js` | CREATE | Thin CLI wrapper that validates the backup file exists, shows what will be overwritten, and requires `--confirm` |

### Phase 7: Rollback System
| Step | File | Action | Description |
|------|------|--------|-------------|
| 7.1 | `cli/lib/deployer.js` | EDIT | During `deployToHosting`, capture Firebase Hosting release version from the deploy output (parse stdout for release name/ID). Store in deploy-history.json |
| 7.2 | `cli/lib/rollback.js` | CREATE | `rollbackHosting(clientId, targetVersion)` — shells out to `firebase hosting:clone <source> <target>` or uses Firebase Hosting REST API to revert to a prior release |
| 7.3 | `cli/deploy.js` | EDIT | Add `--rollback <clientId>` flag. Reads deploy-history.json, picks the previous version (or a specified one), calls rollbackHosting. Offers `--also-restore` to restore backup Firestore data |

### Phase 8: Audit & Health Dashboard
| Step | File | Action | Description |
|------|------|--------|-------------|
| 8.1 | `cli/audit.js` | CREATE | `--health` mode: iterates all clients, connects with Admin SDK (read-only), prints table with status/expiry/counts/version |
| 8.2 | `cli/audit.js` | CONTINUE | `--logs` mode: reads `_audit/audit.log`, filters by `--client`, `--action`, `--since`, `--until`. Pretty-prints with chalk coloring for errors/successes |
| 8.3 | `cli/audit.js` | CONTINUE | `--client <id>` mode: deep-dive on one client — subscription history, employee list, usage vs caps, last N audit log entries |

### Phase 9: Tenant Decommissioning
| Step | File | Action | Description |
|------|------|--------|-------------|
| 9.1 | `cli/destroy.js` | CREATE | `--client <id>` mode: (1) dry-run by default — prints everything that WOULD be deleted (Firestore collections, Auth users, hosting channels), (2) `--confirm` to actually execute. Takes a FINAL backup before destroying. Writes a "decommissioned" tombstone file in the vault so the client ID can't be reused |
| 9.2 | `cli/destroy.js` | CONTINUE | Requires TWO confirmations: first typing the client ID, second typing "DELETE ALL DATA". Prevents accidental destruction |

### Phase 10: Secrets Encryption (Optional Enhancement)
| Step | File | Action | Description |
|------|------|--------|-------------|
| 10.1 | `cli/lib/vault.js` | EDIT | Add `encryptEnv(clientId, passphrase)`, `decryptEnv(clientId, passphrase)`. Use Node.js `crypto` module with AES-256-GCM, PBKDF2 key derivation |
| 10.2 | `cli/lib/vault.js` | CONTINUE | Add `setMasterKey(passphrase)` / `getMasterKey()` — reads/writes `.vault-key` file in vault root. All other scripts call `getMasterKey()` transparently |
| 10.3 | ALL SCRIPTS | EDIT | Add optional `--key <passphrase>` flag to override master key. If no key file exists and no flag, scripts operate in plaintext mode (backward compatible) |

---

## 5. File Change Summary

| Phase | File | Action | Tokens Est. |
|-------|------|--------|-------------|
| **0** | `package.json` | CREATE | ~500 |
| **0** | `.gitignore` | EDIT | ~100 |
| **0** | `cli/` directory | CREATE | — |
| **1** | `cli/lib/vault.js` | CREATE | ~1,500 |
| **1** | `cli/lib/validator.js` | CREATE | ~1,800 |
| **1** | `cli/lib/logger.js` | CREATE | ~1,200 |
| **2** | `cli/create-client.js` | CREATE | ~3,000 |
| **2** | `cli/lib/firebase-admin.js` | CREATE | ~2,000 |
| **3** | `cli/lib/seeder.js` | CREATE | ~3,500 |
| **4** | `core/vision-init.js` | EDIT | ~300 |
| **4** | `suspended.html` | EDIT | ~100 |
| **4** | `*.html` (12 files) | EDIT | ~600 |
| **4** | `cli/lib/injection.js` | CREATE | ~2,000 |
| **5** | `cli/lib/deployer.js` | CREATE | ~2,500 |
| **5** | `cli/deploy.js` | CREATE | ~2,500 |
| **6** | `cli/lib/backup.js` | CREATE | ~2,000 |
| **6** | `cli/backup.js` | CREATE | ~1,000 |
| **6** | `cli/lib/restore.js` | CREATE | ~2,000 |
| **6** | `cli/restore.js` | CREATE | ~800 |
| **7** | `cli/lib/deployer.js` | EDIT | ~500 |
| **7** | `cli/lib/rollback.js` | CREATE | ~1,800 |
| **7** | `cli/deploy.js` | EDIT | ~400 |
| **8** | `cli/audit.js` | CREATE | ~2,800 |
| **9** | `cli/destroy.js` | CREATE | ~2,400 |
| **10** | `cli/lib/vault.js` | EDIT | ~1,000 |
| **10** | ALL SCRIPTS | EDIT | ~500 |
| **TOTAL** | | | **~33,000 tokens** |

---

## 6. Implementation Order & Dependencies

```
Phase 0 (Scaffolding)
  │
  ▼
Phase 1 (Vault + Validator + Logger)  ←── foundation libraries
  │
  ▼
Phase 2 (create-client.js interactive)
  │
  ▼
Phase 3 (Seeder — Admin SDK writes)   ←── depends on Phase 2
  │
  ▼
Phase 4 (Template Injection)          ←── independent: edits frontend files
  │
  ▼
Phase 5 (deploy.js deployment engine) ←── depends on Phase 1 + 4
  │
  ├──▶ Phase 6 (Backup & Restore)    ←── parallelizable after Phase 5
  ├──▶ Phase 7 (Rollback)            ←── parallelizable after Phase 5
  ├──▶ Phase 8 (Audit & Health)      ←── parallelizable after Phase 5
  ├──▶ Phase 9 (Destroy/Decommission) ←── parallelizable after Phase 6
  └──▶ Phase 10 (Encryption)         ←── last: wraps vault.js
```

**Phases 0–5 are strictly sequential.** Phases 6–9 can be parallelized after Phase 5 completes. Phase 10 is the final polish layer.

---

## 7. Super Admin Credentials Strategy

Per your requirement, the `create-client.js` seeder creates:
1. **A locked Super Admin account** — YOUR fixed credentials (email + password). This account is written to Firebase Auth + `/employees/{uid}` with `role: 'super_admin'`. Its credentials are stored ONLY in a single `cli/seeder-config.js` file (gitignored, never in the vault).
2. **The Client Admin account** — credentials from the interactive prompts, written to Firebase Auth + `/employees/{uid}` with `role: 'admin'`.

The super_admin email/password should be configurable via a `cli/seeder-config.json` file:
```json
{
  "superAdminEmail": "your-email@example.com",
  "superAdminPassword": "your-strong-password",
  "superAdminDisplayName": "System Owner"
}
```
This file is `.gitignore`-d and never committed. If the file is missing, `create-client.js` prompts for the super admin credentials interactively (for flexibility).

---

## 8. Next Steps — Awaiting Your Approval

Please review and respond with:
- ✅ **"Approved — execute all phases as planned"** OR
- 🔧 **"Approved with changes"** — list which enhancements to keep/remove/modify
- ❓ **"Questions about..."** — ask for clarification on any point

Once approved, I will begin implementing **Phase 0 (Scaffolding)** immediately.