#!/usr/bin/env node
/**
 * cli/deploy.js — Deployment CLI
 * ===============================
 *
 * Command-line interface for deploying one or all clients to Firebase Hosting.
 *
 * Usage:
 *   node cli/deploy.js --client elnour         # Deploy single client
 *   node cli/deploy.js --all                   # Deploy all clients sequentially
 *   node cli/deploy.js --all --continue         # Deploy all; don't stop on first failure
 *   node cli/deploy.js --client elnour --dry-run  # Inject only, no Firebase upload
 *   node cli/deploy.js --client elnour --verbose  # Stream Firebase output live
 *   node cli/deploy.js --cleanup               # Remove old build cache dirs
 *   node cli/deploy.js --list                  # Show all deployable clients
 *
 * The source directory for injection defaults to the ERP project root
 * (two levels up from cli/). Override with --source <path>.
 */

'use strict';

const path = require('path');
const chalk = require('chalk');
const ora = require('ora');
const vault = require('./lib/vault.js');
const deployer = require('./lib/deployer.js');
const rollbackLib = require('./lib/rollback.js');
const logger = require('./lib/logger.js');

/* ─────────────────────────────────────────────
 * DEFAULTS
 * ───────────────────────────────────────────── */

/**
 * Resolve the ERP source directory (repo root with HTML/JS files).
 * cli/deploy.js → cli/ → project root = 2 levels up
 */
const DEFAULT_SOURCE_DIR = path.resolve(__dirname, '..');

/* ─────────────────────────────────────────────
 * CLI ARG PARSING
 * ───────────────────────────────────────────── */

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    clientId: null,
    all: false,
    dryRun: false,
    verbose: false,
    skipBackup: false,
    continueOnError: false,
    cleanup: false,
    list: false,
    rollback: false,
    alsoRestore: false,
    sourceDir: DEFAULT_SOURCE_DIR,
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
      case '--dry-run':
      case '-n':
        options.dryRun = true;
        break;
      case '--verbose':
      case '-v':
        options.verbose = true;
        break;
      case '--skip-backup':
        options.skipBackup = true;
        break;
      case '--continue':
        options.continueOnError = true;
        break;
      case '--source':
      case '-s':
        options.sourceDir = path.resolve(args[++i] || DEFAULT_SOURCE_DIR);
        break;
      case '--cleanup':
        options.cleanup = true;
        break;
      case '--list':
      case '-l':
        options.list = true;
        break;
      case '--rollback':
      case '-r':
        options.rollback = true;
        break;
      case '--also-restore':
        options.alsoRestore = true;
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
      default:
        console.log(chalk.yellow(`Unknown option: ${args[i]}`));
        break;
    }
  }

  return options;
}

function printHelp() {
  console.log(`
  ${chalk.bold.blue('Nazamly ERP — Deployment CLI')}

  ${chalk.bold('Usage:')}
    node cli/deploy.js [options]

  ${chalk.bold('Options:')}
    --client, -c <id>   Deploy a single client
    --all, -a            Deploy all clients in the vault sequentially
    --continue            (with --all) Keep deploying after a failure
    --dry-run, -n         Build and inject only — do not upload to Firebase
    --verbose, -v         Stream Firebase CLI output live
    --skip-backup         Skip pre-deploy backup (not recommended)
    --source, -s <path>   Source directory with HTML/JS placeholders
                           (default: ERP project root)
    --rollback, -r         Roll back to previous deploy version (requires --client)
    --also-restore         (with --rollback) Also restore Firestore from backup
    --key <passphrase>    Master passphrase for decrypting .env files
    --key-file <path>     File containing the master passphrase
    --cleanup             Remove build cache directories older than 7 days
    --list, -l            List all deployable clients in the vault
    --help, -h            Show this help

  ${chalk.bold('Examples:')}
    node cli/deploy.js --client elnour
    node cli/deploy.js --all
    node cli/deploy.js --client elnour --dry-run --verbose
    node cli/deploy.js --all --skip-backup
    node cli/deploy.js --client elnour --rollback
    node cli/deploy.js --client elnour --rollback --also-restore

  ${chalk.dim('Prerequisites:')}
    - firebase-tools installed: npm install -g firebase-tools
    - Logged into Firebase:      npx firebase-tools login
    - Client .env in vault:      node cli/create-client.js
`);
}

/* ─────────────────────────────────────────────
 * VALIDATE OPTIONS
 * ───────────────────────────────────────────── */

function validateOptions(options) {
  const errors = [];

  // Must specify at least one action
  const hasAction = options.clientId || options.all || options.cleanup || options.list || options.rollback;
  if (!hasAction) {
    errors.push('No action specified. Use --client, --all, --rollback, --cleanup, or --list.');
  }

  // --client and --all are mutually exclusive
  if (options.clientId && options.all) {
    errors.push('--client and --all cannot be used together.');
  }

  // --rollback requires --client
  if (options.rollback && !options.clientId) {
    errors.push('--rollback requires --client.');
  }

  // --also-restore requires --rollback
  if (options.alsoRestore && !options.rollback) {
    errors.push('--also-restore requires --rollback.');
  }

  // --continue only makes sense with --all
  if (options.continueOnError && !options.all) {
    console.log(chalk.yellow('  ⚠ --continue has no effect without --all'));
  }

  return errors;
}

/* ─────────────────────────────────────────────
 * SINGLE CLIENT DEPLOY
 * ───────────────────────────────────────────── */

async function deploySingle(clientId, options) {
  // Check client exists
  if (!vault.clientExists(clientId)) {
    throw new Error(
      `Client "${clientId}" not found in vault.\n` +
      `Available clients: ${vault.listClients().join(', ') || '(none)'}\n` +
      `Run: node cli/create-client.js --client ${clientId}`
    );
  }

  const envData = vault.readEnvTransparent(clientId);

  // Check if encrypted and we can't read it
  if (envData._encrypted) {
    console.log('');
    console.log(chalk.red(`✖ Client "${clientId}" .env is encrypted and no master key is available.`));
    console.log(chalk.dim(`  Provide --key <passphrase> or create a .vault-key file.`));
    console.log(chalk.dim(`  See: vault set-key --help`));
    console.log('');
    return { success: false, error: envData._error || 'Encrypted .env — no key' };
  }

  const brand = envData.CLIENT_BRAND || clientId;
  const target = envData.DEPLOY_TARGET || 'production';

  console.log('');
  console.log(chalk.bold.blue(`═══ Deploying ${brand} (${clientId}) ═══`));
  console.log(chalk.dim(`  Target: ${target}  |  Project: ${envData.FIREBASE_PROJECT_ID}`));
  if (options.dryRun) {
    console.log(chalk.yellow('  ⚠ DRY-RUN — no files will reach Firebase Hosting'));
  }
  console.log('');

  // Run injection (synchronous — use static log, not spinner, to avoid
  // Windows terminal deadlock with ANSI escape sequences during sync ops)
  console.log(chalk.dim('  ⚙ Injecting placeholders...'));
  let injectReport;
  try {
    injectReport = deployer.prepareDeployment(clientId, options.sourceDir, envData);
  } catch (e) {
    console.log(chalk.red(`  ✖ Injection crashed: ${e.message}`));
    return { success: false, error: e.message };
  }

  if (!injectReport.success) {
    console.log(chalk.red(`  ✖ Injection failed: ${injectReport.error}`));
    return { success: false, error: injectReport.error };
  }

  console.log(chalk.green(
    `  ✓ ${injectReport.injectionReport.filesProcessed} files processed, ` +
    `${injectReport.injectionReport.totalReplacements} placeholders replaced`
  ));

  // Run deploy
  console.log(chalk.dim('  ⚙ Deploying to Firebase Hosting...'));
  const deploySpinner = ora('Deploying to Firebase Hosting...').start();

  const result = await deployer.executeDeploy(
    injectReport.workspaceDir,
    envData.FIREBASE_PROJECT_ID,
    {
      dryRun: options.dryRun,
      verbose: options.verbose,
    }
  );

  if (result.success) {
    if (options.dryRun) {
      deploySpinner.info(result.output);
    } else {
      deploySpinner.succeed(
        `Deployed successfully in ${result.durationMs}ms` +
        (result.hostingVersion ? ` (version: ${result.hostingVersion})` : '')
      );
    }
  } else {
    deploySpinner.fail(result.error);
    if (result.output && !options.verbose) {
      console.log(chalk.dim('\n  Firebase output:'));
      console.log(chalk.dim(`  ${result.output.split('\n').join('\n  ')}`));
    }
  }

  // Record in history
  deployer.recordDeploy(clientId, {
    deployTarget: target,
    hostingVersion: result.hostingVersion,
    projectId: envData.FIREBASE_PROJECT_ID,
    injectionReport: injectReport.injectionReport,
    durationMs: result.durationMs,
    success: result.success,
    error: result.error,
  });

  return result;
}

/* ─────────────────────────────────────────────
 * BATCH DEPLOY (--all)
 * ───────────────────────────────────────────── */

async function deployAll(options) {
  const clients = vault.listClients();

  if (clients.length === 0) {
    console.log(chalk.yellow('\n  No clients found in vault. Run create-client.js first.\n'));
    return;
  }

  console.log('');
  console.log(chalk.bold.blue(`═══ Deploying ALL clients (${clients.length}) ═══`));
  console.log(chalk.dim(`  Clients: ${clients.join(', ')}`));
  if (options.dryRun) {
    console.log(chalk.yellow('  ⚠ DRY-RUN — nothing uploaded'));
  }
  if (options.continueOnError) {
    console.log(chalk.dim('  Mode: continue on error'));
  }
  console.log('');

  // Progress tracking
  const results = [];
  const startTime = Date.now();

  for (let i = 0; i < clients.length; i++) {
    const clientId = clients[i];
    const progress = `[${i + 1}/${clients.length}]`;

    console.log(chalk.cyan(`\n${progress} ${clientId}...`));

    try {
      const result = await deploySingle(clientId, options);
      results.push({ clientId, ...result });

      if (!result.success && !options.continueOnError) {
        console.log(chalk.red(`\n  ✖ Deployment of "${clientId}" failed. Stopping.`));
        console.log(chalk.dim(`  Use --continue to keep deploying after failures.`));
        break;
      }
    } catch (error) {
      results.push({ clientId, success: false, error: error.message });
      if (!options.continueOnError) {
        break;
      }
    }
  }

  // Summary
  const totalDuration = Date.now() - startTime;
  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  console.log('');
  console.log(chalk.bold.blue('─── Deploy Summary ───'));
  console.log(chalk.white(`  Total clients:  ${clients.length}`));
  console.log(chalk.green(`  Succeeded:      ${succeeded}`));
  if (failed > 0) {
    console.log(chalk.red(`  Failed:         ${failed}`));
    for (const r of results) {
      if (!r.success) {
        console.log(chalk.red(`    - ${r.clientId}: ${r.error}`));
      }
    }
  }
  console.log(chalk.dim(`  Duration:       ${Math.round(totalDuration / 1000)}s`));
  console.log('');
}

/* ─────────────────────────────────────────────
 * ROLLBACK
 * ───────────────────────────────────────────── */

async function rollbackClient(options) {
  const clientId = options.clientId;

  if (!vault.clientExists(clientId)) {
    console.log(chalk.red(`\n✖ Client "${clientId}" not found in vault.\n`));
    process.exit(1);
  }

  const envData = vault.readEnvTransparent(clientId);

  // Check if encrypted and we can't read it
  if (envData._encrypted) {
    console.log('');
    console.log(chalk.red(`✖ Client "${clientId}" .env is encrypted and no master key is available.`));
    console.log(chalk.dim(`  Provide --key <passphrase> or create a .vault-key file.`));
    console.log('');
    process.exit(1);
  }

  const brand = envData.CLIENT_BRAND || clientId;

  console.log('');
  console.log(chalk.bold.red(`═══ Rolling back ${brand} (${clientId}) ═══`));

  // Show available targets
  const listResult = rollbackLib.listRollbackTargets(clientId);
  if (!listResult.success) {
    console.log(chalk.red(`\n✖ ${listResult.error}\n`));
    process.exit(1);
  }

  console.log(chalk.dim('\n  Deploy history:'));
  for (const e of listResult.entries.slice(0, 5)) {
    const marker = e.index === 0 ? chalk.cyan(' ← CURRENT') : '';
    const eligible = e.rollbackEligible ? chalk.green('eligible') : chalk.red('failed');
    console.log(chalk.dim(`    [#${e.index}] ${e.timestamp} — ${e.version} (${eligible})${marker}`));
  }

  // Show what we're rolling back to
  const target = rollbackLib.findTargetEntry(clientId, 1); // previous deploy
  if (!target.success) {
    console.log(chalk.red(`\n✖ ${target.error}\n`));
    if (listResult.entries.length > 2) {
      console.log(chalk.dim(`  Try an earlier entry: node cli/deploy.js --client ${clientId} --rollback`));
    }
    process.exit(1);
  }

  console.log('');
  console.log(chalk.yellow(`  Rolling back to: ${target.entry.timestamp}`));
  console.log(chalk.yellow(`  Version:   ${target.entry.hostingVersion || 'unknown'}`));
  console.log(chalk.yellow(`  Commit:    ${target.entry.commitHash || 'unknown'}`));
  if (options.alsoRestore) {
    console.log(chalk.yellow(`  Restore:   YES — will restore Firestore from backup`));
  }

  // Confirm interactively
  const { default: inquirer } = await import('inquirer');
  const { confirm } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirm',
    message: chalk.bold.red('Roll back to this version? This will change what users see.'),
    default: false,
  }]);

  if (!confirm) {
    console.log(chalk.yellow('\n  ✖ Aborted by user.\n'));
    process.exit(0);
  }

  // Execute
  const spinner = ora('Rolling back...').start();

  const result = await rollbackLib.executeRollback(clientId, {
    target: 1,
    dryRun: options.dryRun || false,
    alsoRestore: options.alsoRestore || false,
    verbose: options.verbose || false,
  });

  if (result.success) {
    if (options.dryRun) {
      spinner.info(result.summary);
    } else {
      spinner.succeed(
        `Rolled back to ${result.hostingVersion || 'previous version'} ` +
        `via ${result.rollbackMethod}`
      );
    }
    if (result.restoreResult) {
      if (result.restoreResult.success) {
        console.log(chalk.green(`  ✓ Firestore data restored — ${result.restoreResult.restoredDocuments} docs`));
      } else {
        console.log(chalk.yellow(`  ⚠ Firestore restore failed: ${result.restoreResult.error}`));
      }
    }
    console.log('');
  } else {
    spinner.fail(result.error);
    console.log('');
    process.exit(1);
  }
}

/* ─────────────────────────────────────────────
 * MAIN
 * ───────────────────────────────────────────── */

async function main() {
  // Initialize logger
  logger.init();

  const options = parseArgs();

  // Validate
  const errors = validateOptions(options);
  if (errors.length > 0) {
    for (const err of errors) {
      console.log(chalk.red(`✖ ${err}`));
    }
    console.log(chalk.dim('  Use --help for usage information.'));
    process.exit(1);
  }

  // Resolve master key for encryption (if --key or .vault-key is available)
  const keyResult = vault.resolveMasterKey({ flag: options.key, file: options.keyFile });
  if (!keyResult.success) {
    console.log(chalk.red(`\n✖ Key error: ${keyResult.error}\n`));
    process.exit(1);
  }
  if (keyResult.mode === 'encrypted') {
    console.log(chalk.dim(`  🔒 Encryption active (key from ${keyResult.source})`));
  }

  // --list mode
  if (options.list) {
    const clients = vault.listClients();
    if (clients.length === 0) {
      console.log(chalk.yellow('\n  No clients in vault.\n'));
    } else {
      console.log(chalk.bold.blue(`\n  Deployable clients (${clients.length}):\n`));
      for (const cid of clients) {
        const env = vault.readEnvTransparent(cid);
        if (env._encrypted) {
          console.log(`    ${chalk.white(cid)}  —  ${chalk.red('[ENCRYPTED — no key]')}`);
        } else {
          console.log(`    ${chalk.white(cid)}  —  ${chalk.dim(env.CLIENT_BRAND || 'unknown')}  |  ${chalk.dim(env.DEPLOY_TARGET || 'production')}`);
        }
      }
      console.log('');
    }
    return;
  }

  // --cleanup mode
  if (options.cleanup) {
    const result = deployer.cleanupBuildCache(7);
    console.log(chalk.white(`\n  Cleaned ${result.deleted} old build(s), freed ~${result.freedMB} MB\n`));
    return;
  }

  // --rollback mode
  if (options.rollback) {
    await rollbackClient(options);
    return;
  }

  // --client mode
  if (options.clientId) {
    try {
      await deploySingle(options.clientId, options);
    } catch (error) {
      console.log(chalk.red(`\n✖ ${error.message}\n`));
      process.exit(1);
    }
    return;
  }

  // --all mode
  if (options.all) {
    await deployAll(options);
    return;
  }
}

// Run
if (require.main === module) {
  main().catch(error => {
    console.error(chalk.red(`\nUnexpected error: ${error.message}`));
    if (error.stack) {
      console.error(chalk.dim(error.stack.split('\n').slice(1, 5).join('\n')));
    }
    process.exit(1);
  });
}

/* ─────────────────────────────────────────────
 * EXPORTS
 * ───────────────────────────────────────────── */

module.exports = { deploySingle, deployAll, parseArgs };