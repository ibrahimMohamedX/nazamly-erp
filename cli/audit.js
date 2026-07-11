#!/usr/bin/env node
/**
 * cli/audit.js — Audit & Health Dashboard
 * ========================================
 *
 * Three-in-one read-only inspector for the SaaS tenant fleet:
 *
 *   --health        Bird's-eye table of all clients: status, expiry, counts, versions
 *   --logs          Filterable audit log viewer with chain-verification
 *   --client <id>   Deep-dive on one client: subscription, employees, usage, recent logs
 *
 * This script is READ-ONLY — it connects to Firestore via Admin SDK but
 * never writes. Safe to run at any time for monitoring or troubleshooting.
 *
 * Usage:
 *   node cli/audit.js --health
 *   node cli/audit.js --health --csv
 *   node cli/audit.js --logs --client elnour --action deploy_completed
 *   node cli/audit.js --logs --since 2026-01-01 --limit 50
 *   node cli/audit.js --client elnour
 */

'use strict';

const chalk = require('chalk');
const vault = require('./lib/vault.js');
const fbAdmin = require('./lib/firebase-admin.js');
const logger = require('./lib/logger.js');
const rollback = require('./lib/rollback.js');

/* ─────────────────────────────────────────────
 * ARG PARSING
 * ───────────────────────────────────────────── */

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    health: false,
    logs: false,
    csv: false,
    clientId: null,
    action: null,
    since: null,
    until: null,
    limit: null,
    key: null,
    keyFile: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--health':
        options.health = true;
        break;
      case '--logs':
        options.logs = true;
        break;
      case '--csv':
        options.csv = true;
        break;
      case '--client':
      case '-c':
        options.clientId = args[++i] || null;
        break;
      case '--action':
        options.action = args[++i] || null;
        break;
      case '--since':
        options.since = args[++i] || null;
        break;
      case '--until':
        options.until = args[++i] || null;
        break;
      case '--limit':
        options.limit = parseInt(args[++i], 10) || 50;
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
  ${chalk.bold.blue('Nazamly ERP — Audit & Health Dashboard')}

  ${chalk.bold('Usage:')}
    node cli/audit.js [mode] [options]

  ${chalk.bold('Modes:')}
    --health             Show status overview of all tenants
    --health --csv       Export health table as CSV
    --logs               View and filter the audit log
    --client, -c <id>    Deep-dive into a single client

  ${chalk.bold('Log filter options (with --logs):')}
    --client <id>        Filter by client
    --action <type>      Filter by action (e.g. deploy_completed)
    --since <date>       Entries after this date/time
    --until <date>       Entries before this date/time
    --limit <n>          Max entries to show (default: 50)
    --key <passphrase>    Master passphrase for decrypting .env files
    --key-file <path>     File containing the master passphrase

  ${chalk.bold('Examples:')}
    node cli/audit.js --health
    node cli/audit.js --health --csv > tenants.csv
    node cli/audit.js --logs --limit 20
    node cli/audit.js --logs --client elnour --action deploy_completed
    node cli/audit.js --logs --since 2026-06-01 --limit 100
    node cli/audit.js --client elnour
`);
}

/* ─────────────────────────────────────────────
 * HEALTH DASHBOARD
 * ───────────────────────────────────────────── */

/**
 * Build a health report for all clients in the vault.
 * Connects to each client's Firestore to read:
 *   - /system_status/config → isActive, endDate
 *   - /employees            → employee count
 *   - /products             → product count (if it exists)
 *   - deploy-history.json   → last deploy date + version
 *
 * Clients that fail to connect are flagged with a connection error
 * but still listed (vault data is always available).
 *
 * @returns {Promise<Array<Object>>} array of client health objects
 */
async function buildHealthReport() {
  const clientIds = vault.listClients();
  if (clientIds.length === 0) {
    return [];
  }

  const rows = [];

  for (const clientId of clientIds) {
    const env = vault.readEnvTransparent(clientId);
    const row = {
      clientId,
      brand: env._encrypted ? '[encrypted]' : (env.CLIENT_BRAND || clientId),
      deployTarget: env._encrypted ? '?' : (env.DEPLOY_TARGET || 'production'),
      domain: env._encrypted ? '?' : (env.CLIENT_DOMAIN || '-'),
      projectId: env._encrypted ? '?' : (env.FIREBASE_PROJECT_ID || '?'),
      subscriptionMonths: env._encrypted ? 0 : (parseInt(env.SUBSCRIPTION_MONTHS, 10) || 0),

      // Firestore-derived (populated if connectivity works)
      isActive: '?',
      startDate: null,
      endDate: null,
      daysRemaining: null,
      employeeCount: null,
      productCount: null,

      // Deploy history
      lastDeployDate: null,
      lastDeployVersion: null,
      deploymentCount: null,

      // Connection
      connected: false,
      error: null,
    };

    // Skip Firestore connection if .env is encrypted and unreadable
    if (env._encrypted) {
      row.error = env._error || '.env encrypted — no key';
      rows.push(row);
      continue;
    }

    // Try connecting to Firestore
    const appResult = await fbAdmin.getAdminApp(clientId);
    if (!appResult.success) {
      row.error = appResult.error;
      rows.push(row);
      continue;
    }

    row.connected = true;

    try {
      // /system_status/config
      const statusDoc = await appResult.db.collection('system_status').doc('config').get();
      if (statusDoc.exists) {
        const status = statusDoc.data();
        row.isActive = status.isActive === true;
        if (status.startDate) {
          row.startDate = new Date(status.startDate._seconds ? status.startDate._seconds * 1000 : status.startDate);
        }
        if (status.endDate) {
          row.endDate = new Date(status.endDate._seconds ? status.endDate._seconds * 1000 : status.endDate);
          const now = Date.now();
          row.daysRemaining = Math.ceil((row.endDate.getTime() - now) / (1000 * 60 * 60 * 24));
        }
      }

      // /employees count
      try {
        const employeesSnap = await appResult.db.collection('employees').count().get();
        row.employeeCount = employeesSnap.data()?.count || 0;
      } catch (_) {
        // count() may not be available in older Firestore emulators
        const employeesSnap = await appResult.db.collection('employees').get();
        row.employeeCount = employeesSnap.size;
      }

      // /products count (optional — may not exist)
      try {
        const productsSnap = await appResult.db.collection('products').count().get();
        row.productCount = productsSnap.data()?.count || 0;
      } catch (_) {
        try {
          const productsSnap = await appResult.db.collection('products').get();
          row.productCount = productsSnap.size;
        } catch (__) {
          row.productCount = 0;
        }
      }
    } catch (error) {
      row.error = error.message;
    }

    // Deploy history (from vault, no Firestore needed)
    const historyResult = rollback.readDeployHistory(clientId);
    if (historyResult.success && historyResult.history.length > 0) {
      row.deploymentCount = historyResult.history.filter(e => e.type !== 'rollback').length;
      const lastDeploy = historyResult.history.find(e => e.success && e.type !== 'rollback');
      if (lastDeploy) {
        row.lastDeployDate = lastDeploy.timestamp;
        row.lastDeployVersion = lastDeploy.hostingVersion;
      }
    }

    rows.push(row);
  }

  return rows;
}

/**
 * Print the health table to console with color coding.
 *
 * @param {Array<Object>} rows
 * @param {boolean} csv — if true, output CSV instead of formatted table
 */
function printHealthTable(rows, csv) {
  if (rows.length === 0) {
    console.log(chalk.yellow('\n  No clients in vault.\n'));
    return;
  }

  if (csv) {
    printHealthCSV(rows);
    return;
  }

  console.log('');
  console.log(chalk.bold.blue(`═══ Tenant Health Dashboard (${rows.length} clients) ═══`));
  console.log('');

  // Header
  const header =
    padR('Client', 14) +
    padR('Brand', 18) +
    padR('Status', 10) +
    padR('Days Left', 10) +
    padR('Employees', 10) +
    padR('Products', 9) +
    padR('Last Deploy', 21) +
    padR('Connected', 10);
  console.log(chalk.bold(header));
  console.log(chalk.dim('─'.repeat(header.length)));

  for (const row of rows) {
    // Status color
    let statusColor = chalk.white;
    let statusText;
    if (!row.connected) {
      statusText = 'OFFLINE';
      statusColor = chalk.red;
    } else if (row.isActive === true) {
      statusText = 'ACTIVE';
      statusColor = chalk.green;
    } else if (row.isActive === false) {
      statusText = 'SUSPENDED';
      statusColor = chalk.yellow;
    } else {
      statusText = 'UNKNOWN';
      statusColor = chalk.dim;
    }

    // Days remaining color
    let daysColor = chalk.white;
    let daysText;
    if (row.daysRemaining === null) {
      daysText = '?';
      daysColor = chalk.dim;
    } else if (row.daysRemaining <= 0) {
      daysText = `${row.daysRemaining} ⚠`;
      daysColor = chalk.red;
    } else if (row.daysRemaining <= 30) {
      daysText = row.daysRemaining.toString();
      daysColor = chalk.yellow;
    } else {
      daysText = row.daysRemaining.toString();
      daysColor = chalk.green;
    }

    // Last deploy format
    let deployDate = '-';
    if (row.lastDeployDate) {
      deployDate = new Date(row.lastDeployDate).toISOString().split('T')[0];
    }

    const line =
      padR(row.clientId, 14) +
      padR(truncate(row.brand, 17), 18) +
      statusColor(padR(statusText, 10)) +
      daysColor(padR(daysText, 10)) +
      padR(row.employeeCount !== null ? row.employeeCount.toString() : '?', 10) +
      padR(row.productCount !== null ? row.productCount.toString() : '?', 9) +
      padR(deployDate, 21) +
      (row.connected ? chalk.green(padR('✓', 10)) : chalk.red(padR('✗', 10)));

    console.log(line);
  }

  console.log('');
  printHealthSummary(rows);
  console.log('');
}

function printHealthSummary(rows) {
  const connected = rows.filter(r => r.connected).length;
  const offline = rows.filter(r => !r.connected).length;
  const active = rows.filter(r => r.isActive === true).length;
  const suspended = rows.filter(r => r.isActive === false).length;
  const expiringSoon = rows.filter(r => r.daysRemaining !== null && r.daysRemaining >= 0 && r.daysRemaining <= 30).length;
  const expired = rows.filter(r => r.daysRemaining !== null && r.daysRemaining < 0).length;
  const totalEmployees = rows.reduce((sum, r) => sum + (r.employeeCount || 0), 0);
  const totalProducts = rows.reduce((sum, r) => sum + (r.productCount || 0), 0);

  console.log(chalk.bold('Summary:'));
  console.log(chalk.dim(`  Connected:   ${connected}/${rows.length}  |  Active: ${active}  |  Suspended: ${suspended}  |  Offline: ${offline}`));
  if (expired > 0) {
    console.log(chalk.red(`  ⚠ Expired:      ${expired} client(s)`));
  }
  if (expiringSoon > 0) {
    console.log(chalk.yellow(`  ⚡ Expiring soon: ${expiringSoon} client(s) (≤30 days)`));
  }
  console.log(chalk.dim(`  Total employees: ${totalEmployees}  |  Total products: ${totalProducts}`));
}

function printHealthCSV(rows) {
  console.log('clientId,brand,deployTarget,projectId,isActive,daysRemaining,employeeCount,productCount,lastDeployDate,connected,error');
  for (const row of rows) {
    const values = [
      escapeCsv(row.clientId),
      escapeCsv(row.brand),
      escapeCsv(row.deployTarget),
      escapeCsv(row.projectId),
      row.isActive === true ? 'active' : row.isActive === false ? 'suspended' : 'unknown',
      row.daysRemaining !== null ? row.daysRemaining : '',
      row.employeeCount !== null ? row.employeeCount : '',
      row.productCount !== null ? row.productCount : '',
      row.lastDeployDate ? new Date(row.lastDeployDate).toISOString().split('T')[0] : '',
      row.connected ? 'yes' : 'no',
      escapeCsv(row.error || ''),
    ];
    console.log(values.join(','));
  }
}

/* ─────────────────────────────────────────────
 * AUDIT LOG VIEWER
 * ───────────────────────────────────────────── */

/**
 * Print audit log entries with filters.
 *
 * @param {Object} options — filters from parseArgs()
 */
function printAuditLogs(options) {
  logger.init();

  const chain = logger.verifyChain();
  const stats = logger.getStatistics();

  console.log('');
  console.log(chalk.bold.blue('═══ Audit Log Viewer ═══'));
  console.log(chalk.dim(`  Total entries: ${stats.totalEntries}  |  Success: ${stats.successCount}  |  Failures: ${stats.failureCount}  |  Warnings: ${stats.warningCount}`));

  // Chain integrity
  if (chain.valid) {
    console.log(chalk.green(`  Chain integrity: ✓ VALID (${chain.totalEntries} entries, no tampering)`));
  } else {
    console.log(chalk.red(`  Chain integrity: ✗ BROKEN (${chain.brokenLinks.length} broken links, ${chain.tamperedEntries.length} tampered entries)`));
    for (const b of chain.brokenLinks) {
      console.log(chalk.red(`    Line ${b.line}: expected ${b.expected}, found ${b.found}`));
    }
  }

  console.log('');

  // Query with filters
  const entries = logger.queryEntries({
    clientId: options.clientId,
    action: options.action,
    since: options.since,
    until: options.until,
    limit: options.limit || 50,
  });

  if (entries.length === 0) {
    console.log(chalk.yellow('  No matching log entries.\n'));
    return;
  }

  console.log(chalk.dim(`  Showing ${entries.length} matching entries:\n`));

  // Header
  const header =
    padR('Timestamp', 22) +
    padR('Client', 14) +
    padR('Action', 24) +
    padR('Result', 10) +
    padR('Duration', 9);
  console.log(chalk.bold(header));
  console.log(chalk.dim('─'.repeat(header.length)));

  for (const entry of entries) {
    let resultColor;
    switch (entry.result) {
      case 'success': resultColor = chalk.green; break;
      case 'failure': resultColor = chalk.red; break;
      case 'warning': resultColor = chalk.yellow; break;
      default: resultColor = chalk.white;
    }

    const ts = entry.timestamp.replace('T', ' ').substring(0, 19);
    const client = entry.clientId || '(system)';
    const action = entry.action || '?';
    const duration = entry.durationMs ? `${entry.durationMs}ms` : '';

    const line =
      chalk.dim(padR(ts, 22)) +
      padR(truncate(client, 13), 14) +
      padR(truncate(action, 23), 24) +
      resultColor(padR(entry.result, 10)) +
      padR(duration, 9);

    console.log(line);

    // Show metadata summary for interesting entries
    if (entry.metadata && entry.metadata.errorMessage) {
      console.log(chalk.red(`    ⚠ ${truncate(entry.metadata.errorMessage, 100)}`));
    }
  }

  console.log('');
}

/* ─────────────────────────────────────────────
 * SINGLE CLIENT DEEP-DIVE
 * ───────────────────────────────────────────── */

/**
 * Print a detailed report for a single client.
 * Includes subscription status, employee list, usage vs caps,
 * deploy history, and recent audit log entries.
 *
 * @param {string} clientId
 * @returns {Promise<void>}
 */
async function printClientDeepDive(clientId) {
  if (!vault.clientExists(clientId)) {
    console.log(chalk.red(`\n✖ Client "${clientId}" not found in vault.\n`));
    process.exit(1);
  }

  const env = vault.readEnvTransparent(clientId);

  if (env._encrypted) {
    console.log('');
    console.log(chalk.bold.red(`═══ Client Deep-Dive: ${clientId} ═══`));
    console.log(chalk.red(`  .env is ENCRYPTED and no master key is available.`));
    console.log(chalk.dim(`  ${env._error || 'Provide --key <passphrase> to decrypt.'}`));
    console.log('');
    process.exit(1);
  }

  const brand = env.CLIENT_BRAND || clientId;

  console.log('');
  console.log(chalk.bold.blue(`═══ Client Deep-Dive: ${brand} (${clientId}) ═══`));
  console.log('');

  // ── Vault config ──
  console.log(chalk.bold('── Configuration ──'));
  const sensitiveKeys = vault.getSensitiveKeys();
  for (const { key, required } of vault.getSchema()) {
    let val = env[key];
    if (val === undefined || val === null || val === '') {
      val = chalk.dim('(not set)');
    } else if (sensitiveKeys.has(key)) {
      val = chalk.yellow('[masked]');
    }
    const label = required ? chalk.bold(key) : chalk.dim(key);
    console.log(`  ${padR(label, 24)} ${val}`);
  }
  console.log('');

  // ── Firestore data ──
  const appResult = await fbAdmin.getAdminApp(clientId);
  if (!appResult.success) {
    console.log(chalk.red(`  Cannot connect to Firebase: ${appResult.error}\n`));
  } else {
    console.log(chalk.bold('── Subscription Status ──'));
    try {
      const statusDoc = await appResult.db.collection('system_status').doc('config').get();
      if (statusDoc.exists) {
        const status = statusDoc.data();
        const isActive = status.isActive === true;
        const statusColor = isActive ? chalk.green : chalk.red;
        console.log(`  Status:       ${statusColor(isActive ? 'ACTIVE' : 'SUSPENDED')}`);
        console.log(`  Start date:   ${formatFirestoreDate(status.startDate)}`);
        console.log(`  End date:     ${formatFirestoreDate(status.endDate)}`);
        if (status.endDate) {
          const endMs = status.endDate._seconds ? status.endDate._seconds * 1000 : new Date(status.endDate).getTime();
          const daysLeft = Math.ceil((endMs - Date.now()) / (1000 * 60 * 60 * 24));
          const daysColor = daysLeft <= 0 ? chalk.red : daysLeft <= 30 ? chalk.yellow : chalk.green;
          console.log(`  Days left:    ${daysColor(daysLeft.toString())}`);
        }
        if (status.usageCaps) {
          console.log(`  Usage caps:   max ${status.usageCaps.maxEmployees || '?'} employees, max ${status.usageCaps.maxProducts || '?'} products`);
        }
      } else {
        console.log(chalk.dim('  No /system_status/config document found.'));
      }
    } catch (e) {
      console.log(chalk.red(`  Error reading status: ${e.message}`));
    }
    console.log('');

    // ── Employees ──
    console.log(chalk.bold('── Employees ──'));
    try {
      const employeesSnap = await appResult.db.collection('employees').get();
      console.log(`  Total: ${employeesSnap.size}`);
      if (employeesSnap.size > 0) {
        const roleCounts = {};
        employeesSnap.forEach(doc => {
          const role = doc.data().role || 'unknown';
          roleCounts[role] = (roleCounts[role] || 0) + 1;
        });
        for (const [role, count] of Object.entries(roleCounts)) {
          const roleColor = role === 'super_admin' ? chalk.red : role === 'admin' ? chalk.yellow : chalk.white;
          console.log(`    ${roleColor(padR(role, 16))} ${count}`);
        }
      }
    } catch (e) {
      console.log(chalk.red(`  Error: ${e.message}`));
    }
    console.log('');

    // ── System config ──
    console.log(chalk.bold('── System Config ──'));
    try {
      const sysDoc = await appResult.db.collection('system').doc('config').get();
      if (sysDoc.exists) {
        const cfg = sysDoc.data();
        console.log(`  Brand:        ${cfg.brandName || brand}`);
        console.log(`  Allowed emails: ${Array.isArray(cfg.allowedEmails) ? cfg.allowedEmails.join(', ') : 'none'}`);
      } else {
        console.log(chalk.dim('  No /system/config document found.'));
      }
    } catch (e) {
      console.log(chalk.dim(`  Error: ${e.message}`));
    }
    console.log('');
  }

  // ── Deploy history ──
  console.log(chalk.bold('── Deploy History (last 5) ──'));
  const historyResult = rollback.readDeployHistory(clientId);
  if (historyResult.success) {
    const recent = historyResult.history.slice(0, 5);
    for (const entry of recent) {
      const ts = entry.timestamp.replace('T', ' ').substring(0, 19);
      const type = entry.type === 'rollback' ? chalk.yellow('[ROLLBACK]') : '';
      const status = entry.success ? chalk.green('✓') : chalk.red('✗');
      console.log(`  ${ts}  ${status} ${type}  ${entry.hostingVersion || '?'}/${entry.commitHash || '?'}  (${entry.durationMs || 0}ms)`);
    }
    console.log(`  Total entries: ${historyResult.history.length}`);
  } else {
    console.log(chalk.dim(`  ${historyResult.error}`));
  }
  console.log('');

  // ── Recent audit log ──
  console.log(chalk.bold('── Recent Audit Log (last 10) ──'));
  const logEntries = logger.queryEntries({ clientId, limit: 10 });
  if (logEntries.length === 0) {
    console.log(chalk.dim('  No entries.'));
  } else {
    for (const entry of logEntries) {
      const ts = entry.timestamp.replace('T', ' ').substring(0, 19);
      const resultIcon = entry.result === 'success' ? chalk.green('✓') : entry.result === 'failure' ? chalk.red('✗') : chalk.yellow('⚠');
      console.log(`  ${ts}  ${resultIcon}  ${entry.action || '?'}  ${entry.osUser || '?'}  (${entry.durationMs || 0}ms)`);
    }
  }
  console.log('');
}

/* ─────────────────────────────────────────────
 * UTILITIES
 * ───────────────────────────────────────────── */

function padR(str, len) {
  const s = String(str || '');
  if (s.length >= len) return s.substring(0, len);
  return s + ' '.repeat(len - s.length);
}

function truncate(str, maxLen) {
  const s = String(str || '');
  if (s.length <= maxLen) return s;
  return s.substring(0, maxLen - 2) + '..';
}

function escapeCsv(val) {
  const s = String(val || '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function formatFirestoreDate(field) {
  if (!field) return '-';
  if (field._seconds) {
    return new Date(field._seconds * 1000).toISOString().split('T')[0];
  }
  try {
    return new Date(field).toISOString().split('T')[0];
  } catch (_) {
    return String(field);
  }
}

/* ─────────────────────────────────────────────
 * MAIN
 * ───────────────────────────────────────────── */

async function main() {
  logger.init();
  const options = parseArgs();

  // Resolve master key
  const keyResult = vault.resolveMasterKey({ flag: options.key, file: options.keyFile });
  if (!keyResult.success) {
    console.log(chalk.red(`\n✖ Key error: ${keyResult.error}\n`));
    process.exit(1);
  }
  if (keyResult.mode === 'encrypted') {
    console.log(chalk.dim(`  🔒 Encryption active (key from ${keyResult.source})`));
  }

  const hasMode = options.health || options.logs || options.clientId;
  if (!hasMode) {
    console.log(chalk.yellow('\n  No mode specified. Use --health, --logs, or --client.\n'));
    console.log(chalk.dim('  Try: node cli/audit.js --health'));
    console.log(chalk.dim('   or: node cli/audit.js --health --csv'));
    console.log(chalk.dim('   or: node cli/audit.js --client elnour'));
    console.log(chalk.dim('   or: node cli/audit.js --logs --limit 20\n'));
    process.exit(0);
  }

  // --health
  if (options.health) {
    const rows = await buildHealthReport();
    printHealthTable(rows, options.csv);
    return;
  }

  // --logs
  if (options.logs) {
    printAuditLogs(options);
    return;
  }

  // --client deep-dive
  if (options.clientId) {
    await printClientDeepDive(options.clientId);
    return;
  }
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

module.exports = { buildHealthReport, printHealthTable, printAuditLogs, printClientDeepDive };