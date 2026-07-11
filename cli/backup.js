#!/usr/bin/env node
/**
 * cli/backup.js — Backup CLI
 * ===========================
 *
 * Usage:
 *   node cli/backup.js --client elnour       # Backup one client
 *   node cli/backup.js --all                 # Backup all clients
 *   node cli/backup.js --client elnour --list  # List existing backups
 *   node cli/backup.js --client elnour --prune  # Keep only last 10 backups
 *   node cli/backup.js --client elnour --collections orders,products
 */

'use strict';

const path = require('path');
const chalk = require('chalk');
const ora = require('ora');
const vault = require('./lib/vault.js');
const backupLib = require('./lib/backup.js');
const logger = require('./lib/logger.js');

/* ─────────────────────────────────────────────
 * ARG PARSING
 * ───────────────────────────────────────────── */

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    clientId: null,
    all: false,
    list: false,
    prune: false,
    collections: null,
    compact: false,
    key: null,
    keyFile: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--client':
      case '-c':
        options.clientId = args[++i] || null;
        break;
      case '--all':
      case '-a':
        options.all = true;
        break;
      case '--list':
      case '-l':
        options.list = true;
        break;
      case '--prune':
        options.prune = true;
        break;
      case '--collections':
        options.collections = (args[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
        break;
      case '--compact':
        options.compact = true;
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
  ${chalk.bold.blue('Nazamly ERP — Backup CLI')}

  ${chalk.bold('Usage:')}
    node cli/backup.js [options]

  ${chalk.bold('Options:')}
    --client, -c <id>    Backup a single client
    --all, -a             Backup all clients in the vault
    --list, -l            List existing backup files for a client (requires --client)
    --prune               Delete old backups, keep only the latest 10 (requires --client)
    --collections <list>  Export only specific collections (comma-separated)
    --compact             Minify JSON output (smaller files)
    --key <passphrase>    Master passphrase for decrypting .env files
    --key-file <path>     File containing the master passphrase
    --help, -h            Show this help

  ${chalk.bold('Examples:')}
    node cli/backup.js --client elnour
    node cli/backup.js --all
    node cli/backup.js --client elnour --collections orders,products
    node cli/backup.js --client elnour --list
    node cli/backup.js --client elnour --prune
`);
}

/* ─────────────────────────────────────────────
 * MAIN
 * ───────────────────────────────────────────── */

async function main() {
  logger.init();
  const options = parseArgs();

  // Validate
  if (!options.clientId && !options.all && !options.prune) {
    console.log(chalk.red('\n✖ Must specify --client, --all, or --prune\n'));
    process.exit(1);
  }

  if ((options.list || options.prune || options.collections) && !options.clientId) {
    console.log(chalk.red('\n✖ --list, --prune, and --collections require --client\n'));
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

  // ── List mode ──
  if (options.list) {
    const result = backupLib.listBackups(options.clientId);
    if (!result.success) {
      console.log(chalk.red(`\n✖ ${result.error}\n`));
      process.exit(1);
    }
    if (result.backups.length === 0) {
      console.log(chalk.yellow(`\n  No backups for "${options.clientId}"\n`));
    } else {
      console.log(chalk.bold.blue(`\n  Backups for ${options.clientId} (${result.backups.length}):\n`));
      for (const b of result.backups) {
        const sizeKB = Math.round(b.size / 1024);
        const age = Math.round((Date.now() - b.timestamp.getTime()) / (1000 * 60 * 60 * 24));
        console.log(`    ${chalk.white(b.filename)}  ${chalk.dim(`${sizeKB} KB  |  ${age}d ago`)}`);
      }
      console.log('');
    }
    return;
  }

  // ── Prune mode ──
  if (options.prune) {
    const result = backupLib.pruneBackups(options.clientId);
    if (result.deleted > 0) {
      console.log(chalk.white(`\n  Pruned ${result.deleted} old backup(s), kept ${result.kept}\n`));
    } else {
      console.log(chalk.dim(`\n  Nothing to prune (${result.kept} backups, within limit)\n`));
    }
    return;
  }

  // ── Backup mode (--client or --all) ──
  if (options.all) {
    const clients = vault.listClients();
    if (clients.length === 0) {
      console.log(chalk.yellow('\n  No clients in vault.\n'));
      return;
    }

    console.log(chalk.bold.blue(`\n═══ Backing up ALL clients (${clients.length}) ═══\n`));

    for (let i = 0; i < clients.length; i++) {
      const cid = clients[i];
      console.log(chalk.cyan(`[${i + 1}/${clients.length}] ${cid}...`));

      const spinner = ora('Exporting Firestore...').start();
      const result = await backupLib.exportFirestore(cid, {
        collections: options.collections,
        compact: options.compact,
      });

      if (result.success) {
        const sizeMB = (result.backupSize / (1024 * 1024)).toFixed(2);
        spinner.succeed(`${result.totalDocuments} docs in ${result.totalCollections} collections — ${sizeMB} MB`);
      } else {
        spinner.fail(result.error);
      }
    }

    console.log(chalk.green('\n═══ Done ═══\n'));
  } else {
    // Single client
    if (!vault.clientExists(options.clientId)) {
      console.log(chalk.red(`\n✖ Client "${options.clientId}" not found in vault.\n`));
      process.exit(1);
    }

    console.log(chalk.bold.blue(`\n═══ Backing up ${options.clientId} ═══\n`));

    const spinner = ora('Exporting Firestore...').start();
    const result = await backupLib.exportFirestore(options.clientId, {
      collections: options.collections,
      compact: options.compact,
    });

    if (result.success) {
      const sizeMB = (result.backupSize / (1024 * 1024)).toFixed(2);
      spinner.succeed(`${result.totalDocuments} documents in ${result.totalCollections} collections — ${sizeMB} MB`);
      console.log(chalk.dim(`  Saved to: ${result.backupPath}`));
      if (result.errors) {
        console.log(chalk.yellow(`  ⚠ ${result.errors.length} collection(s) had errors:`));
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
}

if (require.main === module) {
  main().catch(error => {
    console.error(chalk.red(`\nUnexpected error: ${error.message}`));
    process.exit(1);
  });
}

module.exports = { main };