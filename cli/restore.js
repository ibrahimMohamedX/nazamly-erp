#!/usr/bin/env node
/**
 * cli/restore.js — Restore CLI
 * ==============================
 *
 * Restore a Firestore backup into a client's Firebase project.
 * THIS IS A DESTRUCTIVE OPERATION — it overwrites existing data.
 *
 * Usage:
 *   node cli/restore.js --client elnour --backup <path> --dry-run
 *   node cli/restore.js --client elnour --latest --confirm
 *   node cli/restore.js --client elnour --backup <path> --confirm
 *
 * Restore Safety Requirements:
 *   - --confirm flag is MANDATORY (prevents accidental execution)
 *   - Backup structure is validated before any writes
 *   - --dry-run previews what will be restored without writing
 *   - --collections flag limits scope
 */

'use strict';

const chalk = require('chalk');
const inquirer = require('inquirer');
const vault = require('./lib/vault.js');
const restoreLib = require('./lib/restore.js');
const backupLib = require('./lib/backup.js');
const logger = require('./lib/logger.js');

/* ─────────────────────────────────────────────
 * ARG PARSING
 * ───────────────────────────────────────────── */

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    clientId: null,
    backupPath: null,
    latest: false,
    confirm: false,
    dryRun: false,
    collections: null,
    merge: false,
    key: null,
    keyFile: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--client':
      case '-c':
        options.clientId = args[++i] || null;
        break;
      case '--backup':
      case '-b':
        options.backupPath = args[++i] || null;
        break;
      case '--latest':
        options.latest = true;
        break;
      case '--confirm':
        options.confirm = true;
        break;
      case '--dry-run':
      case '-n':
        options.dryRun = true;
        break;
      case '--collections':
        options.collections = (args[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
        break;
      case '--merge':
        options.merge = true;
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
  ${chalk.bold.red('Nazamly ERP — Restore CLI')}
  ${chalk.red('⚠ DESTRUCTIVE OPERATION — overwrites Firestore data')}

  ${chalk.bold('Usage:')}
    node cli/restore.js --client <id> --backup <path> --confirm
    node cli/restore.js --client <id> --latest --confirm
    node cli/restore.js --client <id> --latest --dry-run

  ${chalk.bold('Options:')}
    --client, -c <id>    Target client to restore data into
    --backup, -b <path>  Path to the backup JSON file
    --latest              Use the most recent backup automatically
    --confirm             REQUIRED — acknowledge the destructive operation
    --dry-run, -n         Preview only — show what would be restored
    --collections <list>  Restore only specific collections (comma-separated)
    --merge               Merge mode — preserve fields not in backup
    --key <passphrase>    Master passphrase for decrypting .env files
    --key-file <path>     File containing the master passphrase
    --help, -h            Show this help

  ${chalk.bold('Examples:')}
    node cli/restore.js --client elnour --latest --dry-run
    node cli/restore.js --client elnour --backup ./backups/elnour.json --confirm
    node cli/restore.js --client elnour --latest --confirm --collections orders,products
`);
}

/* ─────────────────────────────────────────────
 * MAIN
 * ───────────────────────────────────────────── */

async function main() {
  logger.init();
  const options = parseArgs();

  // Validation
  if (!options.clientId) {
    console.log(chalk.red('\n✖ --client is required\n'));
    process.exit(1);
  }

  if (!vault.clientExists(options.clientId)) {
    console.log(chalk.red(`\n✖ Client "${options.clientId}" not found in vault.\n`));
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

  // Resolve backup path
  let backupPath = options.backupPath;
  if (options.latest) {
    const latestResult = restoreLib.getLatestBackup(options.clientId);
    if (!latestResult.success) {
      console.log(chalk.red(`\n✖ ${latestResult.error}\n`));
      process.exit(1);
    }
    backupPath = latestResult.backupPath;
  }

  if (!backupPath) {
    console.log(chalk.red('\n✖ Must specify --backup <path> or --latest\n'));
    console.log(chalk.dim('  Use --list to see available backups: node cli/backup.js --client ' + options.clientId + ' --list\n'));
    process.exit(1);
  }

  // ── Dry-run (safe, no confirmation needed) ──
  if (options.dryRun) {
    console.log(chalk.bold.blue(`\n═══ Restore Preview for ${options.clientId} ═══`));
    console.log(chalk.dim(`  Backup: ${backupPath}`));
    if (options.collections) {
      console.log(chalk.dim(`  Collections: ${options.collections.join(', ')}`));
    }
    console.log(chalk.yellow('  ⚠ DRY-RUN — NO DATA WILL BE WRITTEN\n'));

    const preview = restoreLib.dryRunRestore(backupPath, options.collections);

    if (!preview.success) {
      console.log(chalk.red(`✖ ${preview.error}\n`));
      process.exit(1);
    }

    const p = preview.preview;
    console.log(chalk.white(`  Source client:   ${p.clientId || 'unknown'}`));
    console.log(chalk.white(`  Source project:  ${p.projectId || 'unknown'}`));
    console.log(chalk.white(`  Exported at:     ${p.exportedAt}`));
    console.log(chalk.white(`  Collections:     ${p.totalCollections}`));
    console.log(chalk.white(`  Total documents: ${p.totalDocuments}`));
    console.log(chalk.dim('\n  Per collection:'));
    for (const [name, count] of Object.entries(p.perCollection)) {
      console.log(chalk.dim(`    ${name}: ${count} documents`));
    }
    if (p.missingCollections && p.missingCollections.length > 0) {
      console.log(chalk.yellow(`\n  ⚠ Requested but not in backup: ${p.missingCollections.join(', ')}`));
    }
    console.log('');
    return;
  }

  // ── Live restore (requires --confirm) ──
  if (!options.confirm) {
    console.log(chalk.red('\n✖ --confirm flag is REQUIRED for live restore.\n'));
    console.log(chalk.yellow('  This operation will OVERWRITE data in Firestore.'));
    console.log(chalk.dim('  Run with --dry-run first to preview what will be restored.\n'));
    process.exit(1);
  }

  // Double-confirm interactively
  console.log(chalk.bold.red(`\n═══ DESTRUCTIVE RESTORE: ${options.clientId} ═══`));
  console.log(chalk.yellow(`  Backup: ${backupPath}`));
  const restoreEnv = vault.readEnvTransparent(options.clientId);
  if (restoreEnv._encrypted) {
    console.log(chalk.red(`  Target: [ENCRYPTED — no key available]`));
    console.log(chalk.red(`\n✖ Cannot restore without access to client .env. Provide --key.\n`));
    process.exit(1);
  }
  console.log(chalk.yellow(`  Target: ${restoreEnv.FIREBASE_PROJECT_ID}`));
  if (options.collections) {
    console.log(chalk.yellow(`  Collections: ${options.collections.join(', ')}`));
  }
  console.log(chalk.red('\n  ⚠ THIS WILL OVERWRITE FIRESTORE DATA FOR THIS CLIENT.\n'));

  const { confirm } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirm',
    message: chalk.bold.red('Are you sure you want to RESTORE and overwrite existing data?'),
    default: false,
  }]);

  if (!confirm) {
    console.log(chalk.yellow('\n  ✖ Aborted by user. No data was modified.\n'));
    process.exit(0);
  }

  // Execute restore
  const ora = require('ora');
  const spinner = ora('Restoring Firestore data...').start();

  const result = await restoreLib.importFirestore(options.clientId, backupPath, {
    collections: options.collections,
    merge: options.merge,
    dryRun: false,
    onProgress: (coll, done, total) => {
      spinner.text = `Restoring ${coll}... (${done}/${total} docs)`;
    },
  });

  if (result.success) {
    spinner.succeed(
      `Restore complete — ${result.restoredDocuments} documents in ${result.restoredCollections} collections`
    );
    console.log(chalk.dim(`  Duration: ${result.durationMs}ms`));
    if (result.errors) {
      console.log(chalk.yellow(`  ⚠ ${result.errors.length} warning(s):`));
      for (const e of result.errors) {
        console.log(chalk.yellow(`    - ${e}`));
      }
    }
    console.log('');
  } else {
    spinner.fail(result.error);
    console.log('');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(chalk.red(`\nUnexpected error: ${error.message}`));
    process.exit(1);
  });
}

module.exports = { main };