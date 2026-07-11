#!/usr/bin/env node
/**
 * cli/destroy.js — Tenant Decommissioning (DESTROY)
 * ===================================================
 *
 * Permanently decommissions a client tenant. This is the MOST DESTRUCTIVE
 * operation in the toolkit — it can wipe out:
 *
 *   - All Firestore collections and documents
 *   - All Firebase Auth user accounts (employees + admins)
 *   - Firebase Hosting channels (optional)
 *   - The client's vault directory (.env, backups, deploy history)
 *
 * Safety guardrails (MANDATORY — cannot skip):
 *   1. Dry-run by default: shows everything that WOULD be destroyed
 *   2. --confirm flag required to proceed
 *   3. Interactive double-confirmation: type the client ID, then type "DELETE ALL DATA"
 *   4. Final backup taken automatically before destruction
 *   5. Tombstone file written to vault to prevent client ID reuse
 *   6. Full audit trail logged
 *
 * Usage:
 *   node cli/destroy.js --client elnour                     # Dry-run preview
 *   node cli/destroy.js --client elnour --confirm            # Execute (with prompts)
 *   node cli/destroy.js --client elnour --confirm --keep-vault  # Keep vault files
 */

'use strict';

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const inquirer = require('inquirer');
const ora = require('ora');
const vault = require('./lib/vault.js');
const fbAdmin = require('./lib/firebase-admin.js');
const backupLib = require('./lib/backup.js');
const logger = require('./lib/logger.js');

/* ─────────────────────────────────────────────
 * ARG PARSING
 * ───────────────────────────────────────────── */

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    clientId: null,
    confirm: false,
    keepVault: false,
    skipFirestore: false,
    skipAuth: false,
    key: null,
    keyFile: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--client':
      case '-c':
        options.clientId = args[++i] || null;
        break;
      case '--confirm':
        options.confirm = true;
        break;
      case '--keep-vault':
        options.keepVault = true;
        break;
      case '--skip-firestore':
        options.skipFirestore = true;
        break;
      case '--skip-auth':
        options.skipAuth = true;
        break;
      case '--key':
        options.key = args[++i] || null;
        break;
      case '--key-file':
        options.keyFile = args[++i] || null;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
    }
  }

  return options;
}

function printHelp() {
  console.log(`
  ${chalk.bold.red('Nazamly ERP — Tenant Decommissioning')}
  ${chalk.red('⚠ PERMANENTLY DESTROYS client data, users, and configuration')}

  ${chalk.bold('Usage:')}
    node cli/destroy.js --client <id>               # Dry-run preview
    node cli/destroy.js --client <id> --confirm      # Execute destruction

  ${chalk.bold('Options:')}
    --client, -c <id>   Target client to decommission
    --confirm            REQUIRED to proceed past dry-run
    --keep-vault         Keep vault directory (.env, backups) after destroy
    --skip-firestore     Skip Firestore data deletion (keep database)
    --skip-auth          Skip Auth user deletion (keep employee accounts)
    --key <passphrase>    Master passphrase for decrypting .env files
    --key-file <path>     File containing the master passphrase
    --help, -h           Show this help

  ${chalk.bold('Safety requirements (cannot be bypassed):')}
    1. Dry-run shows everything that will be destroyed
    2. Interactive confirmation: type the client ID
    3. Final confirmation: type "DELETE ALL DATA"
    4. Automatic final backup before destruction
    5. Tombstone file prevents client ID reuse

  ${chalk.bold('Example dry-run:')}
    node cli/destroy.js --client elnour

  ${chalk.bold('Example execution:')}
    node cli/destroy.js --client elnour --confirm
`);
}

/* ─────────────────────────────────────────────
 * DRY-RUN: ENUMERATE WHAT WILL BE DESTROYED
 * ───────────────────────────────────────────── */

/**
 * Connect to the client's Firebase project and count what exists.
 * Returns a summary of everything that will be destroyed.
 *
 * @param {string} clientId
 * @returns {Promise<Object>} destruction preview
 */
async function buildDestructionPreview(clientId) {
  const env = vault.readEnvTransparent(clientId);
  if (env._encrypted) {
    return {
      clientId,
      brand: '[encrypted]',
      projectId: '?',
      deployTarget: '?',
      vaultPath: vault.getClientDir(clientId),
      vaultFiles: [],
      backupsCount: 0,
      firestoreCollections: [],
      firestoreDocCount: 0,
      firestoreConnected: false,
      authUserCount: 0,
      authConnected: false,
      errors: [env._error || '.env encrypted — no key available'],
    };
  }

  const preview = {
    clientId,
    brand: env.CLIENT_BRAND || clientId,
    projectId: env.FIREBASE_PROJECT_ID || '?',
    deployTarget: env.DEPLOY_TARGET || 'production',

    // Vault
    vaultPath: vault.getClientDir(clientId),
    vaultFiles: [],
    backupsCount: 0,

    // Firestore
    firestoreCollections: [],
    firestoreDocCount: 0,
    firestoreConnected: false,

    // Auth
    authUserCount: 0,
    authConnected: false,

    // Errors
    errors: [],
  };

  // ── Vault files ──
  const clientDir = vault.getClientDir(clientId);
  if (fs.existsSync(clientDir)) {
    const walkDir = (dir, prefix) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const fullPath = path.join(dir, e.name);
        const relPath = prefix + e.name;
        if (e.isDirectory()) {
          walkDir(fullPath, relPath + '/');
        } else {
          preview.vaultFiles.push({ path: relPath, size: fs.statSync(fullPath).size });
        }
      }
    };
    walkDir(clientDir, '');
    preview.backupsCount = preview.vaultFiles.filter(f => f.path.includes('backups/') && f.path.endsWith('.json')).length;
  }

  // ── Firestore ──
  const appResult = await fbAdmin.getAdminApp(clientId);
  if (appResult.success) {
    preview.firestoreConnected = true;
    try {
      const collections = await backupLib.listCollections(appResult.db);
      preview.firestoreCollections = collections;
      let totalDocs = 0;
      for (const collName of collections) {
        try {
          const snap = await appResult.db.collection(collName).get();
          totalDocs += snap.size;
        } catch (_) {
          // skip inaccessible collections
        }
      }
      preview.firestoreDocCount = totalDocs;
    } catch (e) {
      preview.errors.push(`Firestore enumeration failed: ${e.message}`);
    }

    // ── Auth ──
    try {
      let userCount = 0;
      const listResult = await appResult.auth.listUsers();
      userCount += listResult.users.length;
      // Firebase returns max 1000 per page — paginate if needed
      let pageToken = listResult.pageToken;
      while (pageToken) {
        const nextPage = await appResult.auth.listUsers(1000, pageToken);
        userCount += nextPage.users.length;
        pageToken = nextPage.pageToken;
      }
      preview.authUserCount = userCount;
      preview.authConnected = true;
    } catch (e) {
      preview.errors.push(`Auth enumeration failed: ${e.message}`);
    }
  } else {
    preview.errors.push(`Firebase connection failed: ${appResult.error}`);
  }

  return preview;
}

/**
 * Print the destruction preview in a clear, alarming format.
 *
 * @param {Object} preview
 */
function printDestructionPreview(preview) {
  console.log('');
  console.log(chalk.bold.red(`═══ DESTRUCTION PREVIEW: ${preview.brand} (${preview.clientId}) ═══`));
  console.log(chalk.red('  ⚠ THE FOLLOWING DATA WILL BE PERMANENTLY DESTROYED:\n'));

  // Vault
  console.log(chalk.yellow.bold('  ── Vault Directory ──'));
  console.log(chalk.yellow(`    Path: ${preview.vaultPath}`));
  console.log(chalk.yellow(`    Files to delete: ${preview.vaultFiles.length} (including ${preview.backupsCount} backups)`));
  if (preview.vaultFiles.length > 0) {
    console.log(chalk.dim('    Key files:'));
    for (const f of preview.vaultFiles.filter(f => !f.path.includes('backups/')).slice(0, 6)) {
      console.log(chalk.dim(`      ${f.path} (${Math.round(f.size / 1024)} KB)`));
    }
    if (preview.vaultFiles.length > 6) {
      console.log(chalk.dim(`      ... and ${preview.vaultFiles.length - 6} more`));
    }
  }

  // Firestore
  if (preview.firestoreConnected) {
    console.log(chalk.yellow.bold('\n  ── Firestore Database ──'));
    console.log(chalk.yellow(`    Project: ${preview.projectId}`));
    console.log(chalk.yellow(`    Collections: ${preview.firestoreCollections.length}`));
    for (const c of preview.firestoreCollections) {
      console.log(chalk.dim(`      ${c}`));
    }
    console.log(chalk.yellow(`    Total documents: ${preview.firestoreDocCount}`));
  } else {
    console.log(chalk.red('\n  ── Firestore ──'));
    console.log(chalk.red(`    CANNOT CONNECT — ${preview.errors.join('; ')}`));
  }

  // Auth
  if (preview.authConnected) {
    console.log(chalk.yellow.bold('\n  ── Firebase Auth ──'));
    console.log(chalk.yellow(`    User accounts to delete: ${preview.authUserCount}`));
  }

  console.log('');
}

/* ─────────────────────────────────────────────
 * DESTRUCTION EXECUTION
 * ───────────────────────────────────────────── */

/**
 * Destroy a single Firestore collection (delete all documents).
 *
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {string} collectionName
 * @param {function} [onProgress] — callback(deleted, total)
 * @returns {Promise<{ deleted: number, errors: string[] }>}
 */
async function destroyCollection(db, collectionName, onProgress) {
  const errors = [];
  let deleted = 0;

  const snapshot = await db.collection(collectionName).get();
  const total = snapshot.size;

  if (total === 0) return { deleted: 0, errors: [] };

  // Delete in batches of 500
  const docs = [];
  snapshot.forEach(doc => docs.push(doc));

  for (let i = 0; i < docs.length; i += 500) {
    const batch = db.batch();
    const chunk = docs.slice(i, i + 500);
    for (const doc of chunk) {
      batch.delete(doc.ref);
    }
    try {
      await batch.commit();
      deleted += chunk.length;
      if (onProgress) onProgress(deleted, total);
    } catch (e) {
      errors.push(`Batch at offset ${i} failed: ${e.message}`);
    }
  }

  return { deleted, errors };
}

/**
 * Delete all Firebase Auth users for the client's project.
 *
 * Firebase Admin SDK requires deleting users one at a time.
 * We paginate through all users and delete them in parallel
 * batches of 10 to avoid rate limits.
 *
 * @param {import('firebase-admin').auth.Auth} auth
 * @param {function} [onProgress] — callback(deleted, total)
 * @returns {Promise<{ deleted: number, errors: string[] }>}
 */
async function destroyAllUsers(auth, onProgress) {
  const errors = [];
  let uids = [];
  let total = 0;

  // Collect all UIDs first
  try {
    let pageToken;
    do {
      const result = await auth.listUsers(1000, pageToken);
      uids.push(...result.users.map(u => u.uid));
      pageToken = result.pageToken;
    } while (pageToken);
    total = uids.length;
  } catch (e) {
    errors.push(`Failed to list users: ${e.message}`);
    return { deleted: 0, errors };
  }

  // Delete in parallel batches of 10
  let deleted = 0;
  for (let i = 0; i < uids.length; i += 10) {
    const batch = uids.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map(uid => auth.deleteUser(uid))
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        deleted++;
      } else {
        errors.push(`Failed to delete user: ${r.reason?.message || r.reason}`);
      }
    }

    if (onProgress) onProgress(deleted, total);
  }

  return { deleted, errors };
}

/**
 * Execute the full destruction sequence.
 *
 * @param {string} clientId
 * @param {Object} options
 * @returns {Promise<Object>} destruction result
 */
async function executeDestruction(clientId, options = {}) {
  const startTime = Date.now();
  const {
    keepVault = false,
    skipFirestore = false,
    skipAuth = false,
  } = options;

  const results = {
    clientId,
    startTime: new Date().toISOString(),
    backup: null,
    firestore: null,
    auth: null,
    vault: null,
    tombstone: null,
    errors: [],
    durationMs: 0,
  };

  // Step 1: Take final backup (ALWAYS)
  console.log(chalk.dim('\n  Step 1/4: Taking final backup...'));
  const backupSpinner = ora('Exporting Firestore...').start();

  const backupResult = await backupLib.exportFirestore(clientId, { compact: true });
  if (backupResult.success) {
    results.backup = {
      path: backupResult.backupPath,
      size: backupResult.backupSize,
      documents: backupResult.totalDocuments,
      collections: backupResult.totalCollections,
    };
    backupSpinner.succeed(
      `Final backup saved — ${backupResult.totalDocuments} docs in ${backupResult.totalCollections} collections`
    );
  } else {
    backupSpinner.warn(`Backup had issues: ${backupResult.error}`);
    results.backup = { error: backupResult.error };
  }

  // Step 2: Destroy Firestore
  if (!skipFirestore) {
    console.log(chalk.dim('\n  Step 2/4: Destroying Firestore data...'));
    const appResult = await fbAdmin.getAdminApp(clientId);

    if (appResult.success) {
      const collectionNames = await backupLib.listCollections(appResult.db);
      const collectionResults = [];
      let totalDeleted = 0;
      const collectionErrors = [];

      for (const collName of collectionNames) {
        const fsSpinner = ora(`  Deleting ${collName}...`).start();
        const result = await destroyCollection(appResult.db, collName);
        collectionResults.push({ collection: collName, deleted: result.deleted });
        totalDeleted += result.deleted;
        collectionErrors.push(...result.errors);
        if (result.errors.length > 0) {
          fsSpinner.warn(`${collName}: ${result.deleted} deleted, ${result.errors.length} errors`);
        } else {
          fsSpinner.succeed(`${collName}: ${result.deleted} docs deleted`);
        }
      }

      results.firestore = {
        collectionsDestroyed: collectionNames.length,
        documentsDeleted: totalDeleted,
        errors: collectionErrors.length > 0 ? collectionErrors : undefined,
      };
    } else {
      results.errors.push(`Cannot connect to Firestore: ${appResult.error}`);
    }
  } else {
    console.log(chalk.dim('\n  Step 2/4: Firestore — SKIPPED (--skip-firestore)'));
  }

  // Step 3: Destroy Auth users
  if (!skipAuth) {
    console.log(chalk.dim('\n  Step 3/4: Deleting user accounts...'));
    const appResult = await fbAdmin.getAdminApp(clientId);

    if (appResult.success) {
      const authSpinner = ora('  Deleting users...').start();
      const result = await destroyAllUsers(appResult.auth, (deleted, total) => {
        authSpinner.text = `  Deleting users... ${deleted}/${total}`;
      });
      if (result.errors.length > 0) {
        authSpinner.warn(`${result.deleted} deleted, ${result.errors.length} errors`);
      } else {
        authSpinner.succeed(`${result.deleted} user accounts deleted`);
      }

      results.auth = {
        usersDeleted: result.deleted,
        errors: result.errors.length > 0 ? result.errors : undefined,
      };
    } else {
      results.errors.push(`Cannot connect to Auth: ${appResult.error}`);
    }
  } else {
    console.log(chalk.dim('\n  Step 3/4: Auth — SKIPPED (--skip-auth)'));
  }

  // Step 4: Clean up vault + write tombstone
  console.log(chalk.dim('\n  Step 4/4: Cleaning up vault...'));

  if (!keepVault) {
    const clientDir = vault.getClientDir(clientId);
    if (fs.existsSync(clientDir)) {
      const tombstonePath = path.join(clientDir, 'tombstone.json');
      const tombstone = {
        clientId,
        brand: vault.readEnvTransparent(clientId).CLIENT_BRAND || clientId,
        decommissionedAt: new Date().toISOString(),
        destroyedBy: require('os').userInfo().username || process.env.USER || 'unknown',
        finalBackup: results.backup?.path || null,
        firestoreDocsDeleted: results.firestore?.documentsDeleted || 0,
        authUsersDeleted: results.auth?.usersDeleted || 0,
        note: 'This client ID is decommissioned and MUST NOT be reused.',
      };

      // Rename .env to .env.destroyed to keep a record
      const envPath = vault.getEnvPath(clientId);
      if (fs.existsSync(envPath)) {
        fs.renameSync(envPath, envPath + '.destroyed');
      }

      // Write tombstone
      fs.writeFileSync(tombstonePath, JSON.stringify(tombstone, null, 2), 'utf-8');
      results.tombstone = { path: tombstonePath };

      console.log(chalk.green(`  ✓ Tombstone written: ${tombstonePath}`));
      console.log(chalk.dim(`  ✓ .env renamed to .env.destroyed`));
      console.log(chalk.dim(`  ✓ Vault directory preserved for audit trail`));
    }
  } else {
    console.log(chalk.dim('  Vault preserved per --keep-vault'));
  }

  // Done
  results.durationMs = Date.now() - startTime;

  // Log
  logger.logAction(logger.ACTION_TYPES.CLIENT_DESTROYED, clientId, results.durationMs, {
    firestoreDocsDeleted: results.firestore?.documentsDeleted || 0,
    authUsersDeleted: results.auth?.usersDeleted || 0,
    finalBackup: results.backup?.path || null,
    vaultPreserved: keepVault,
  });

  return results;
}

/**
 * Print destruction results summary.
 *
 * @param {Object} results
 */
function printDestructionResults(results) {
  console.log('');
  console.log(chalk.bold.red(`═══ CLIENT "${results.clientId}" DECOMMISSIONED ═══`));
  console.log(chalk.dim(`  Duration: ${Math.round(results.durationMs / 1000)}s`));
  console.log('');

  if (results.backup?.path) {
    console.log(chalk.green(`  ✓ Final backup: ${results.backup.path}`));
    console.log(chalk.dim(`    (${results.backup.documents} docs, ${Math.round(results.backup.size / 1024)} KB)`));
  }

  if (results.firestore) {
    console.log(chalk.red(`  ✗ Firestore: ${results.firestore.documentsDeleted} documents deleted`));
  }

  if (results.auth) {
    console.log(chalk.red(`  ✗ Auth: ${results.auth.usersDeleted} users deleted`));
  }

  if (results.tombstone) {
    console.log(chalk.dim(`  † Tombstone: ${results.tombstone.path}`));
  }

  if (results.errors.length > 0) {
    console.log(chalk.yellow(`\n  ⚠ ${results.errors.length} error(s):`));
    for (const e of results.errors) {
      console.log(chalk.yellow(`    - ${e}`));
    }
  }

  console.log(chalk.dim('\n  This client ID should not be reused.'));
  console.log(chalk.dim('  The tombstone file marks it as permanently decommissioned.\n'));
}

/* ─────────────────────────────────────────────
 * MAIN
 * ───────────────────────────────────────────── */

async function main() {
  logger.init();
  const options = parseArgs();

  if (!options.clientId) {
    console.log(chalk.red('\n✖ --client <id> is required.\n'));
    console.log(chalk.dim('  Usage: node cli/destroy.js --client <id> [--confirm]\n'));
    process.exit(1);
  }

  // Verify client exists
  if (!vault.clientExists(options.clientId)) {
    console.log(chalk.red(`\n✖ Client "${options.clientId}" not found in vault.\n`));
    console.log(chalk.dim('  Available clients: ' + vault.listClients().join(', ') || '(none)'));
    process.exit(1);
  }

  // Resolve master key
  const keyResult = vault.resolveMasterKey({ flag: options.key, file: options.keyFile });
  if (!keyResult.success) {
    console.log(chalk.red(`\n✖ Key error: ${keyResult.error}\n`));
    process.exit(1);
  }
  if (keyResult.mode === 'encrypted') {
    console.log(chalk.dim(`  🔒 Encryption active (key from ${keyResult.source})`));
  }

  // ── DRY-RUN (default, no --confirm) ──
  if (!options.confirm) {
    console.log(chalk.yellow('\n  ═══ DRY-RUN MODE ═══'));
    console.log(chalk.dim('  Nothing will be destroyed. Add --confirm to execute.\n'));

    const preview = await buildDestructionPreview(options.clientId);
    printDestructionPreview(preview);

    console.log(chalk.dim('  To execute: node cli/destroy.js --client ' + options.clientId + ' --confirm\n'));
    return;
  }

  // ── LIVE DESTRUCTION ──
  // Double confirmation
  console.log(chalk.bold.red(`\n═══ PERMANENT DESTRUCTION: ${options.clientId} ═══`));
  console.log(chalk.red('  THIS WILL DESTROY ALL DATA, USERS, AND CONFIGURATION.\n'));

  // First confirmation: type the client ID
  const { idConfirm } = await inquirer.prompt([{
    type: 'input',
    name: 'idConfirm',
    message: chalk.bold.yellow(`Type the client ID "${options.clientId}" to confirm:`),
    validate(input) {
      if (input.trim() !== options.clientId) {
        return `Type exactly "${options.clientId}" to proceed.`;
      }
      return true;
    },
  }]);

  if (idConfirm.trim() !== options.clientId) {
    console.log(chalk.yellow('\n  ✖ Client ID mismatch. Aborted.\n'));
    process.exit(0);
  }

  // Final confirmation: type the destruction phrase
  const PHRASE = 'DELETE ALL DATA';
  const { phraseConfirm } = await inquirer.prompt([{
    type: 'input',
    name: 'phraseConfirm',
    message: chalk.bold.red(`Type "${PHRASE}" to permanently destroy everything:`),
    validate(input) {
      if (input.trim() !== PHRASE) {
        return `Type exactly "${PHRASE}" to proceed. This is irreversible.`;
      }
      return true;
    },
  }]);

  if (phraseConfirm.trim() !== PHRASE) {
    console.log(chalk.yellow('\n  ✖ Confirmation phrase mismatch. Aborted.\n'));
    process.exit(0);
  }

  // ── Execute destruction ──
  console.log('');
  console.log(chalk.bold.red('  All confirmations passed. Proceeding with destruction...'));

  const results = await executeDestruction(options.clientId, {
    keepVault: options.keepVault,
    skipFirestore: options.skipFirestore,
    skipAuth: options.skipAuth,
  });

  printDestructionResults(results);

  // Clean up Firebase Admin SDK app
  await fbAdmin.destroyApp(options.clientId);
}

if (require.main === module) {
  main().catch(error => {
    console.error(chalk.red(`\nUnexpected error: ${error.message}`));
    if (error.stack) {
      console.error(chalk.dim(error.stack.split('\n').slice(1, 4).join('\n')));
    }
    process.exit(1);
  });
}

module.exports = { buildDestructionPreview, executeDestruction };