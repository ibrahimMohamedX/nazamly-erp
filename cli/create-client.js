#!/usr/bin/env node
/**
 * cli/create-client.js — Interactive Tenant Creation Wizard
 * ===========================================================
 *
 * Walks the operator through creating a new SaaS tenant:
 *
 *   1. Collects 14 .env fields via inquirer prompts (with validation)
 *   2. Validates all input via validator.js
 *   3. Writes .env to the external vault via vault.js
 *   4. Optionally tests Firebase connectivity (if service account key exists)
 *   5. Logs the operation to the audit trail
 *
 * Usage:
 *   node cli/create-client.js                  # interactive mode
 *   node cli/create-client.js --client elnour  # pre-fill client ID
 *   node cli/create-client.js --dry-run        # validate only, don't write
 *   node cli/create-client.js --skip-test      # skip connectivity test
 *   node cli/create-client.js --seed elnour    # seed Firestore for existing client
 */

'use strict';

const inquirer = require('inquirer');
const chalk = require('chalk');
const ora = require('ora');
const vault = require('./lib/vault.js');
const validator = require('./lib/validator.js');
const logger = require('./lib/logger.js');

/* ─────────────────────────────────────────────
 * CONSTANTS
 * ───────────────────────────────────────────── */

const SUBSCRIPTION_OPTIONS = [
  { name: '1 month  (trial)',        value: 1 },
  { name: '3 months (quarterly)',    value: 3 },
  { name: '6 months (semi-annual)',  value: 6 },
  { name: '12 months (annual)',      value: 12, checked: true },
];

const DEPLOY_TARGETS = [
  { name: 'production  (live client site)',   value: 'production', checked: true },
  { name: 'staging     (testing environment)', value: 'staging' },
];

// Fields that should be masked during input
const PASSWORD_FIELDS = new Set(['ADMIN_PASSWORD']);

/* ─────────────────────────────────────────────
 * PROMPT DEFINITIONS
 * ───────────────────────────────────────────── */

/**
 * Build the ordered array of inquirer prompts from the .env schema.
 * Each prompt includes:
 *   - Live validation (synchronous per-field checks before moving on)
 *   - Sensible defaults derived from other answers (e.g., auth domain
 *     defaults from project ID)
 *   - Masking for password fields
 *
 * @param {Object} [prefill] — values to pre-fill (e.g., from --client flag)
 * @returns {Array} inquirer prompt objects
 */
function buildPrompts(prefill = {}) {
  const prompts = [];

  // ── Section: Business Identity ──

  prompts.push({
    type: 'input',
    name: 'CLIENT_ID',
    message: 'Client ID (machine name):',
    default: prefill.CLIENT_ID || undefined,
    validate(input) {
      if (!input.trim()) return 'Client ID is required.';
      const result = validator.validateClientId(input.trim());
      if (!result.valid) return result.error;
      // Check it doesn't already exist
      if (!prefill.CLIENT_ID && vault.clientExists(result.normalized)) {
        return `Client "${result.normalized}" already exists in the vault. Choose a different ID.`;
      }
      return true;
    },
    filter(input) {
      return input.trim().toLowerCase();
    },
  });

  prompts.push({
    type: 'input',
    name: 'CLIENT_BRAND',
    message: 'Brand name (Arabic display name):',
    validate(input) {
      if (!input.trim()) return 'Brand name is required (e.g., شركة النور).';
      return true;
    },
    filter(input) {
      return input.trim();
    },
  });

  prompts.push({
    type: 'input',
    name: 'CLIENT_DOMAIN',
    message: 'Custom domain (optional, leave blank if none):',
    default: prefill.CLIENT_DOMAIN || '',
    validate(input) {
      if (input.trim() && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(input.trim())) {
        return 'Enter a valid domain (e.g., elnour.example.com) or leave blank.';
      }
      return true;
    },
    filter(input) {
      return input.trim() || '';
    },
  });

  prompts.push({
    type: 'input',
    name: 'SUPPORT_PHONE',
    message: 'WhatsApp support number (optional, international format):',
    default: prefill.SUPPORT_PHONE || '',
    validate(input) {
      if (input.trim() && !/^\d{7,15}$/.test(input.trim().replace(/^\+/, ''))) {
        return 'Enter a valid phone number (7-15 digits, optionally starting with +) or leave blank.';
      }
      return true;
    },
    filter(input) {
      return input.trim() || '';
    },
  });

  // ── Section: Admin Account ──

  console.log(chalk.dim('\n  ── Admin Account ──'));

  prompts.push({
    type: 'input',
    name: 'ADMIN_EMAIL',
    message: 'Client admin email:',
    validate(input) {
      if (!input.trim()) return 'Admin email is required.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.trim())) {
        return 'Enter a valid email address.';
      }
      return true;
    },
    filter(input) {
      return input.trim().toLowerCase();
    },
  });

  prompts.push({
    type: 'password',
    name: 'ADMIN_PASSWORD',
    message: 'Client admin password:',
    mask: '*',
    validate(input) {
      if (!input) return 'Admin password is required.';
      if (input.length < 8) return 'Password must be at least 8 characters.';
      if (input.length > 128) return 'Password must be under 128 characters.';
      if (!/[A-Z]/.test(input)) return 'Password must contain at least one uppercase letter.';
      if (!/[a-z]/.test(input)) return 'Password must contain at least one lowercase letter.';
      if (!/[0-9]/.test(input)) return 'Password must contain at least one digit.';
      return true;
    },
  });

  // ── Section: Firebase Configuration ──

  console.log(chalk.dim('\n  ── Firebase Project Configuration ──'));
  console.log(chalk.yellow('  Find these in Firebase Console → Project Settings → General → Your apps → Web app → Config'));

  prompts.push({
    type: 'input',
    name: 'FIREBASE_API_KEY',
    message: 'Firebase Web API Key (starts with AIza):',
    validate(input) {
      if (!input.trim()) return 'Firebase API Key is required.';
      if (!validator.KEY_PATTERNS.FIREBASE_API_KEY.pattern.test(input.trim())) {
        return 'API Key must start with "AIza" followed by 35 characters. Copy the full key from Firebase Console.';
      }
      return true;
    },
    filter(input) {
      return input.trim();
    },
  });

  prompts.push({
    type: 'input',
    name: 'FIREBASE_PROJECT_ID',
    message: 'Firebase Project ID:',
    validate(input) {
      if (!input.trim()) return 'Project ID is required.';
      if (!validator.KEY_PATTERNS.FIREBASE_PROJECT_ID.pattern.test(input.trim())) {
        return 'Project ID must be lowercase alphanumeric + hyphens, 6-30 chars.';
      }
      return true;
    },
    filter(input) {
      return input.trim().toLowerCase();
    },
  });

  prompts.push({
    type: 'input',
    name: 'FIREBASE_AUTH_DOMAIN',
    message: 'Firebase Auth Domain:',
    default(answers) {
      if (answers.FIREBASE_PROJECT_ID) {
        return `${answers.FIREBASE_PROJECT_ID}.firebaseapp.com`;
      }
      return '';
    },
    validate(input) {
      if (!input.trim()) return 'Auth Domain is required.';
      // Relaxed check — custom domains are valid
      if (!input.trim().includes('.')) return 'Enter a valid domain.';
      return true;
    },
    filter(input) {
      return input.trim().toLowerCase();
    },
  });

  prompts.push({
    type: 'input',
    name: 'FIREBASE_STORAGE_BUCKET',
    message: 'Firebase Storage Bucket:',
    default(answers) {
      if (answers.FIREBASE_PROJECT_ID) {
        return `${answers.FIREBASE_PROJECT_ID}.appspot.com`;
      }
      return '';
    },
    validate(input) {
      if (!input.trim()) return 'Storage Bucket is required.';
      // Relaxed — alternate domain formats exist
      if (!input.trim().includes('.')) return 'Enter a valid bucket domain.';
      return true;
    },
    filter(input) {
      return input.trim().toLowerCase();
    },
  });

  prompts.push({
    type: 'input',
    name: 'FIREBASE_MSG_SENDER_ID',
    message: 'Firebase Messaging Sender ID (project number):',
    validate(input) {
      if (!input.trim()) return 'Messaging Sender ID is required.';
      if (!validator.KEY_PATTERNS.FIREBASE_MSG_SENDER_ID.pattern.test(input.trim())) {
        return 'Sender ID must be a 10-12 digit number. Copy it from Firebase Console.';
      }
      return true;
    },
    filter(input) {
      return input.trim();
    },
  });

  prompts.push({
    type: 'input',
    name: 'FIREBASE_APP_ID',
    message: 'Firebase Web App ID:',
    validate(input) {
      if (!input.trim()) return 'App ID is required.';
      if (!validator.KEY_PATTERNS.FIREBASE_APP_ID.pattern.test(input.trim())) {
        return 'App ID must be in format: 1:<number>:web:<hex>. Copy it exactly from Firebase Console.';
      }
      return true;
    },
    filter(input) {
      return input.trim();
    },
  });

  // ── Section: Subscription & Environment ──

  console.log(chalk.dim('\n  ── Subscription & Deployment ──'));

  prompts.push({
    type: 'list',
    name: 'SUBSCRIPTION_MONTHS',
    message: 'Initial subscription duration:',
    choices: SUBSCRIPTION_OPTIONS,
    default: 12,
  });

  prompts.push({
    type: 'list',
    name: 'DEPLOY_TARGET',
    message: 'Deployment target:',
    choices: DEPLOY_TARGETS,
    default: 'production',
    filter(input) {
      return input || 'production';
    },
  });

  return prompts;
}

/* ─────────────────────────────────────────────
 * CONFIRMATION SUMMARY
 * ───────────────────────────────────────────── */

/**
 * Render a formatted summary of the collected data for final confirmation.
 * Sensitive fields are partially masked.
 *
 * @param {Object} answers — the collected inquirer answers
 */
function printSummary(answers) {
  const sensitive = vault.getSensitiveKeys();

  console.log(chalk.cyan('\n┌──────────────────────────────────────────────┐'));
  console.log(chalk.cyan('│          CLIENT CONFIGURATION SUMMARY         │'));
  console.log(chalk.cyan('└──────────────────────────────────────────────┘\n'));

  const schema = vault.getSchema();
  const rows = [];

  for (const { key, required } of schema) {
    let value = answers[key];
    if (value === undefined || value === null || value === '') {
      value = chalk.dim('(not set)');
    } else if (sensitive.has(key)) {
      // Mask sensitive values: show first 3 + last 2 chars
      const raw = String(value);
      if (raw.length <= 6) {
        value = chalk.yellow('*'.repeat(raw.length));
      } else {
        value = chalk.yellow(raw.substring(0, 3) + '*'.repeat(raw.length - 5) + raw.substring(raw.length - 2));
      }
    } else {
      value = chalk.white(value);
    }

    const label = required
      ? chalk.bold(`${key}:`)
      : chalk.dim(`${key} (optional):`);

    rows.push(`  ${label}  ${value}`);
  }

  console.log(rows.join('\n'));
  console.log('');
}

/* ─────────────────────────────────────────────
 * MAIN WIZARD FLOW
 * ───────────────────────────────────────────── */

/**
 * Run the full interactive wizard.
 *
 * @param {Object} options
 * @param {string} [options.clientId]   — prefill client ID (from --client flag)
 * @param {boolean} [options.dryRun]    — validate but don't write
 * @param {boolean} [options.skipTest]  — skip Firebase connectivity test
 * @param {boolean} [options.seed]      — seed Firestore after creation (or standalone with --client)
 * @returns {Promise<Object>} the collected and written env data
 */
async function runWizard(options = {}) {
  const { clientId, dryRun = false, skipTest = false, seed = false } = options;

  // ── Header ──
  console.log('');
  console.log(chalk.bold.blue('═══ Nazamly ERP — New Client Setup Wizard ═══'));
  console.log(chalk.dim(`  Vault: ${vault.getVaultRoot()}`));
  if (dryRun) {
    console.log(chalk.yellow('  ⚠ DRY-RUN MODE — no files will be written'));
  }
  console.log('');

  // Initialize logger
  logger.init();

  // Resolve master key for encryption
  const keyResult = vault.resolveMasterKey({ flag: options.key, file: options.keyFile });
  if (!keyResult.success) {
    console.log(chalk.red(`\n✖ Key error: ${keyResult.error}\n`));
    process.exit(1);
  }
  if (keyResult.mode === 'encrypted') {
    console.log(chalk.dim(`  🔒 Encryption active — .env will be encrypted (key from ${keyResult.source})`));
  }

  // ── Seed-only mode: --seed <clientId> without creating a new client ──
  if (seed && clientId && !dryRun) {
    const check = validator.validateClientId(clientId);
    if (!check.valid) {
      console.log(chalk.red(`\n✖ Invalid client ID: ${check.error}`));
      process.exit(1);
    }
    const normalizedId = check.normalized;

    if (!vault.clientExists(normalizedId)) {
      console.log(chalk.red(`\n✖ Client "${normalizedId}" not found in vault.`));
      console.log(chalk.dim(`  Run the full wizard first: node cli/create-client.js --client ${normalizedId}`));
      process.exit(1);
    }

    console.log(chalk.bold.blue(`\n═══ Seeding Firestore for ${normalizedId} ═══`));

    const seeder = require('./lib/seeder.js');
    const seedResult = await seeder.seedClient(normalizedId, {
      log: (msg) => console.log(chalk.dim(`  ${msg}`)),
    });

    if (seedResult.success) {
      console.log(chalk.green('\n✓ Seeding completed successfully.\n'));
      logger.logAction(logger.ACTION_TYPES.DATABASE_SEEDED, normalizedId, 0, {
        superAdminUid: seedResult.superAdminUid,
        clientAdminUid: seedResult.clientAdminUid,
        subscriptionEndDate: seedResult.subscriptionEndDate,
      });
    } else {
      console.log(chalk.red(`\n✖ Seeding failed: ${seedResult.error || 'See summary above.'}`));
      if (seedResult.summary) {
        for (const step of seedResult.summary) {
          if (!step.success) {
            console.log(chalk.red(`  - ${step.step}: ${step.error}`));
          }
        }
      }
      logger.logError(logger.ACTION_TYPES.DATABASE_SEEDED, normalizedId,
        new Error(seedResult.error || 'Seeding failed'));
      process.exit(1);
    }

    return { clientId: normalizedId, seeded: true };
  }

  // Build and run prompts
  const prefill = {};
  if (clientId) {
    const check = validator.validateClientId(clientId);
    if (!check.valid) {
      console.log(chalk.red(`\n✖ Invalid --client ID: ${check.error}`));
      process.exit(1);
    }
    prefill.CLIENT_ID = check.normalized;
  }

  const prompts = buildPrompts(prefill);
  const answers = await inquirer.prompt(prompts);

  // ── Validate ──
  console.log(chalk.dim('\n  Validating...'));
  const report = validator.validateEnv(answers);

  if (report.warnings.length > 0) {
    console.log(chalk.yellow(`\n  ⚠ ${report.warnings.length} warning(s):`));
    for (const w of report.warnings) {
      console.log(chalk.yellow(`    - ${w}`));
    }
  }

  if (!report.valid) {
    console.log(chalk.red(`\n  ✖ ${report.errors.length} validation error(s):`));
    for (const err of report.errors) {
      console.log(chalk.red(`    - ${err}`));
    }
    console.log(chalk.red('\n  Cannot proceed with these errors. Please fix and re-run.\n'));

    logger.logError(logger.ACTION_TYPES.CLIENT_CREATED, answers.CLIENT_ID,
      new Error(`Validation failed: ${report.errors.join('; ')}`));

    process.exit(1);
  }

  console.log(chalk.green(`  ✓ All validations passed`));

  // ── Confirmation ──
  printSummary(answers);

  const { confirm } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirm',
    message: chalk.bold('Write this configuration to the vault?'),
    default: true,
  }]);

  if (!confirm) {
    console.log(chalk.yellow('\n  ✖ Aborted by user. Nothing was written.\n'));
    process.exit(0);
  }

  // ── Write to vault ──
  if (dryRun) {
    console.log(chalk.yellow('\n  [DRY-RUN] Would have written .env to vault.\n'));
    console.log(chalk.green('  ✓ Dry-run complete — configuration is valid.\n'));
    process.exit(0);
  }

  console.log(chalk.dim('  ⚙ Writing .env to vault...'));
  try {
    const writeResult = vault.writeEnvTransparent(answers.CLIENT_ID, answers);
    if (!writeResult.success) {
      console.log(chalk.red(`  ✖ Failed to write .env: ${writeResult.error}`));
      logger.logError(logger.ACTION_TYPES.CLIENT_CREATED, answers.CLIENT_ID, new Error(writeResult.error));
      process.exit(1);
    }
    const encStatus = writeResult.encrypted ? ' (encrypted 🔒)' : '';
    console.log(chalk.green(`  ✓ .env written to ${vault.getEnvPath(answers.CLIENT_ID)}${encStatus}`));
  } catch (error) {
    console.log(chalk.red(`  ✖ Failed to write .env: ${error.message}`));
    logger.logError(logger.ACTION_TYPES.CLIENT_CREATED, answers.CLIENT_ID, error);
    process.exit(1);
  }

  // ── Optional: Firebase connectivity test ──
  if (!skipTest && validator.hasServiceAccountKey(answers.CLIENT_ID)) {
    console.log(chalk.dim('\n  Service account key found — testing Firebase connectivity...'));
    const testSpinner = ora('Connecting to Firebase...').start();

    const testResult = await validator.testFirebaseConnection(answers);

    if (testResult.success) {
      testSpinner.succeed(testResult.summary);
      logger.logAction(logger.ACTION_TYPES.CONNECTIVITY_TESTED, answers.CLIENT_ID,
        testResult.latencyMs, { firebaseConnected: true });
    } else {
      testSpinner.warn(`Connected but with issues: ${testResult.error}`);
      logger.logWarning(logger.ACTION_TYPES.CONNECTIVITY_TESTED, answers.CLIENT_ID,
        testResult.error, testResult.latencyMs);
    }
  } else if (!skipTest) {
    console.log(chalk.dim('\n  ℹ No service account key found — skipping connectivity test.'));
    console.log(chalk.dim(`    To test connectivity, place a service account JSON key at:`));
    console.log(chalk.dim(`    ${validator.getDefaultServiceAccountPath(answers.CLIENT_ID)}`));
  }

  // ── Log success ──
  logger.logAction(logger.ACTION_TYPES.CLIENT_CREATED, answers.CLIENT_ID, 0, {
    brand: answers.CLIENT_BRAND,
    deployTarget: answers.DEPLOY_TARGET,
    subscriptionMonths: answers.SUBSCRIPTION_MONTHS,
    hasDomain: !!answers.CLIENT_DOMAIN,
  });

  // ── Seed after wizard (--seed flag without pre-existing client) ──
  let seedResult = null;
  if (seed && !dryRun) {
    console.log(chalk.dim('\n  --seed flag set — running database seeder...'));

    const seeder = require('./lib/seeder.js');
    seedResult = await seeder.seedClient(answers.CLIENT_ID, {
      log: (msg) => console.log(chalk.dim(`  ${msg}`)),
    });

    if (seedResult.success) {
      console.log(chalk.green('  ✓ Seeding completed.'));
      logger.logAction(logger.ACTION_TYPES.DATABASE_SEEDED, answers.CLIENT_ID, 0, {
        superAdminUid: seedResult.superAdminUid,
        clientAdminUid: seedResult.clientAdminUid,
        subscriptionEndDate: seedResult.subscriptionEndDate,
      });
    } else {
      console.log(chalk.yellow(`  ⚠ Seeding had issues: ${seedResult.error || 'see log'}`));
      if (seedResult.summary) {
        for (const step of seedResult.summary) {
          if (!step.success) {
            console.log(chalk.yellow(`    - ${step.step}: ${step.error}`));
          }
        }
      }
      logger.logWarning(logger.ACTION_TYPES.DATABASE_SEEDED, answers.CLIENT_ID,
        seedResult.error || 'Partial seeding failure');
    }
  }

  // ── Done ──
  console.log('');
  console.log(chalk.green.bold('═══ Client created successfully! ═══'));
  console.log('');
  console.log(chalk.white('  Next steps:'));
  console.log(chalk.dim(`    1. Place service account key: ${validator.getDefaultServiceAccountPath(answers.CLIENT_ID)}`));

  if (!seedResult || !seedResult.success) {
    console.log(chalk.dim(`    2. Run the seeder: node cli/create-client.js --seed ${answers.CLIENT_ID}`));
    console.log(chalk.dim(`    3. Deploy:     node cli/deploy.js --client ${answers.CLIENT_ID}`));
  } else {
    console.log(chalk.dim(`    2. Deploy:     node cli/deploy.js --client ${answers.CLIENT_ID}`));
  }
  console.log('');

  return answers;
}

/* ─────────────────────────────────────────────
 * CLI ENTRY POINT
 * ───────────────────────────────────────────── */

// Parse simple command-line flags (commander is Phase 5 dependency,
// minimal argv parsing here keeps Phase 2 self-contained)
function parseArgs() {
  const args = process.argv.slice(2);
  const options = { clientId: null, dryRun: false, skipTest: false, seed: false, key: null, keyFile: null };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--client':
      case '-c':
        options.clientId = args[++i] || null;
        break;
      case '--dry-run':
      case '-n':
        options.dryRun = true;
        break;
      case '--skip-test':
        options.skipTest = true;
        break;
      case '--key':
        options.key = args[++i] || null;
        break;
      case '--key-file':
        options.keyFile = args[++i] || null;
        break;
      case '--seed':
      case '-s':
        options.seed = true;
        // --seed can be used standalone with a client ID
        if (args[i + 1] && !args[i + 1].startsWith('--')) {
          options.clientId = args[++i] || null;
        }
        break;
      case '--help':
      case '-h':
        console.log(`
  Usage: node cli/create-client.js [options]

  Options:
    --client, -c <id>   Pre-fill the client ID (skip the ID prompt)
    --seed, -s [id]     Seed Firestore database for a client
                        (with id: seed-only mode; without: seed after wizard)
    --dry-run, -n        Validate only — do not write to vault
    --skip-test          Skip Firebase connectivity test
    --key <passphrase>    Master passphrase for encrypting the .env file
    --key-file <path>     File containing the master passphrase
    --help, -h           Show this help
`);
        process.exit(0);
        break;
      default:
        console.log(chalk.yellow(`Unknown option: ${args[i]}`));
        break;
    }
  }

  return options;
}

// Run
if (require.main === module) {
  const options = parseArgs();
  runWizard(options).catch(error => {
    console.error(chalk.red(`\nUnexpected error: ${error.message}`));
    if (error.stack) {
      console.error(chalk.dim(error.stack));
    }
    process.exit(1);
  });
}

/* ─────────────────────────────────────────────
 * EXPORTS (for programmatic use by other scripts)
 * ───────────────────────────────────────────── */

module.exports = { runWizard, buildPrompts, printSummary };