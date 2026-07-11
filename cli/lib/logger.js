/**
 * cli/lib/logger.js — Structured JSON Audit Logging
 * ===================================================
 * Every high-stakes CLI action (tenant creation, deploy, backup, restore,
 * destroy) writes a structured, machine-readable JSON line to the vault's
 * audit log. This provides:
 *
 *   - Operational traceability ("who ran what and when")
 *   - Evidence for client disputes
 *   - Tamper-evident hash-chaining for compliance
 *   - Filterable/queryable log for the `audit.js --logs` dashboard
 *
 * Log location:
 *   ../nazamly-clients-vault/_audit/audit.log   (JSONL — one JSON object per line)
 *
 * Each log entry schema:
 *   {
 *     timestamp:    ISO 8601 with ms precision,
 *     action:       one of the ACTION_TYPES constants,
 *     clientId:     target client (null for system-wide actions),
 *     osUser:       OS username who ran the command,
 *     hostname:     machine hostname,
 *     result:       "success" | "failure" | "warning",
 *     durationMs:   elapsed time in milliseconds,
 *     metadata:     free-form object with action-specific details,
 *     entryHash:    SHA-256 of (previousEntryHash + this entry's JSON),
 *     prevHash:     SHA-256 of the previous entry (null for first entry)
 *   }
 *
 * The hash chain enables tamper detection: if any entry is modified or
 * removed, all subsequent hashes will break. The `audit.js` script can
 * verify the chain integrity.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const vault = require('./vault.js');

/* ─────────────────────────────────────────────
 * ACTION TYPE CONSTANTS
 * ───────────────────────────────────────────── */

/**
 * Canonical set of auditable actions.
 * Every log entry MUST use one of these as its `action` field.
 * Scripts can add new entries here as the toolkit grows.
 */
const ACTION_TYPES = {
  // Tenant lifecycle
  CLIENT_CREATED:        'client_created',
  CLIENT_CONFIG_UPDATED: 'client_config_updated',
  CLIENT_DESTROYED:      'client_destroyed',

  // Deployment
  DEPLOY_STARTED:        'deploy_started',
  DEPLOY_COMPLETED:      'deploy_completed',
  DEPLOY_FAILED:         'deploy_failed',
  DEPLOY_ROLLED_BACK:    'deploy_rolled_back',

  // Data operations
  DATABASE_SEEDED:       'database_seeded',
  BACKUP_CREATED:        'backup_created',
  BACKUP_RESTORED:       'backup_restored',
  BACKUP_FAILED:         'backup_failed',

  // System
  AUDIT_VIEWED:          'audit_viewed',
  HEALTH_CHECK_RUN:      'health_check_run',
  VAULT_INITIALIZED:     'vault_initialized',

  // Validation & connectivity
  VALIDATION_RUN:        'validation_run',
  CONNECTIVITY_TESTED:   'connectivity_tested',

  // Errors
  UNEXPECTED_ERROR:      'unexpected_error',
};

/* ─────────────────────────────────────────────
 * RESULT CONSTANTS
 * ───────────────────────────────────────────── */

const RESULTS = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  WARNING: 'warning',
};

/* ─────────────────────────────────────────────
 * INTERNAL STATE
 * ───────────────────────────────────────────── */

/**
 * Cache of the last entry's hash so we don't have to re-read the
 * entire log file on every write. Null until initialized.
 * @type {string|null}
 */
let lastHash = null;

/**
 * Whether init() has been called successfully.
 * @type {boolean}
 */
let initialized = false;

/* ─────────────────────────────────────────────
 * HASH CHAINING
 * ───────────────────────────────────────────── */

/**
 * Compute SHA-256 hash of a string, returned as hex.
 * @param {string} input
 * @returns {string} 64-character hex digest
 */
function sha256(input) {
  return crypto.createHash('sha256').update(input, 'utf-8').digest('hex');
}

/**
 * Read the last line of the audit log and return its `entryHash` value.
 * If the log is empty or doesn't exist, returns null (genesis entry).
 *
 * @returns {string|null} hash of the last entry, or null
 */
function readLastHash() {
  const logPath = vault.getAuditLogPath();

  if (!fs.existsSync(logPath)) {
    return null;
  }

  const stat = fs.statSync(logPath);
  if (stat.size === 0) {
    return null;
  }

  // Read the last ~4 KB of the file (more than enough for one JSONL line)
  const fd = fs.openSync(logPath, 'r');
  const bufSize = Math.min(4096, stat.size);
  const buf = Buffer.alloc(bufSize);
  fs.readSync(fd, buf, 0, bufSize, stat.size - bufSize);
  fs.closeSync(fd);

  // Split into lines and find the last non-empty one
  const lines = buf.toString('utf-8').split(/\r?\n/);
  // The last element might be empty if the file ends with a newline
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      return entry.entryHash || null;
    } catch (_) {
      // Corrupted line — skip and try the previous one
      continue;
    }
  }

  return null;
}

/* ─────────────────────────────────────────────
 * INITIALIZATION
 * ───────────────────────────────────────────── */

/**
 * Initialize the logger.
 * Ensures the _audit directory exists, reads the last entry's hash
 * for chain continuity, and writes a "logger_initialized" entry
 * if this is a fresh log.
 *
 * Idempotent — safe to call multiple times.
 *
 * @returns {{ success: boolean, error?: string }}
 */
function init() {
  if (initialized) {
    return { success: true };
  }

  try {
    // Ensure vault and audit directory exist
    vault.ensureVaultExists();

    const logPath = vault.getAuditLogPath();
    const isNew = !fs.existsSync(logPath) || fs.statSync(logPath).size === 0;

    // Read the chain head
    lastHash = readLastHash();

    if (isNew) {
      // Write a genesis entry to bootstrap the hash chain
      const genesis = buildEntry({
        action: ACTION_TYPES.VAULT_INITIALIZED,
        clientId: null,
        result: RESULTS.SUCCESS,
        durationMs: 0,
        metadata: { message: 'Audit log initialized', vaultRoot: vault.getVaultRoot() },
      });

      writeEntry(genesis);
      lastHash = genesis.entryHash;
    }

    initialized = true;
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/* ─────────────────────────────────────────────
 * ENTRY CONSTRUCTION
 * ───────────────────────────────────────────── */

/**
 * Build a complete log entry object.
 * Fills in timestamp, osUser, hostname, and computes the hash chain link.
 *
 * @param {Object} opts
 * @param {string} opts.action      — one of ACTION_TYPES
 * @param {string|null} opts.clientId — target client, or null for system-wide
 * @param {string} opts.result      — "success" | "failure" | "warning"
 * @param {number} opts.durationMs  — elapsed time in milliseconds
 * @param {Object} [opts.metadata]  — free-form action-specific data
 * @param {Error}  [opts.error]     — if present, error.message is added to metadata
 * @returns {Object} the log entry (without entryHash yet — writeEntry adds it)
 */
function buildEntry({ action, clientId, result, durationMs, metadata, error }) {
  const osUser = os.userInfo().username || process.env.USER || process.env.USERNAME || 'unknown';
  const hostname = os.hostname() || 'unknown';

  const entry = {
    timestamp: new Date().toISOString(),
    action,
    clientId: clientId || null,
    osUser,
    hostname,
    result,
    durationMs: typeof durationMs === 'number' ? Math.round(durationMs) : 0,
    metadata: Object.assign({}, metadata || {}),
    prevHash: lastHash,
    entryHash: null, // filled by writeEntry
  };

  // If an error was provided, attach its message and stack
  if (error) {
    entry.metadata.errorMessage = error.message || String(error);
    entry.metadata.errorStack = error.stack || null;
    entry.metadata.errorCode = error.code || null;
  }

  return entry;
}

/* ─────────────────────────────────────────────
 * WRITE
 * ───────────────────────────────────────────── */

/**
 * Append a single entry as a JSON line to the audit log.
 * Computes the entryHash (SHA-256 of prevHash + full JSON) before writing.
 *
 * @param {Object} entry — a log entry object from buildEntry()
 */
function writeEntry(entry) {
  // Compute hash: SHA-256(prevHash + JSON without entryHash field)
  const tempEntry = Object.assign({}, entry);
  delete tempEntry.entryHash;
  const jsonWithoutHash = JSON.stringify(tempEntry);
  const hashInput = (entry.prevHash || '') + jsonWithoutHash;
  entry.entryHash = sha256(hashInput);

  const logPath = vault.getAuditLogPath();
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(logPath, line, 'utf-8');
}

/* ─────────────────────────────────────────────
 * PUBLIC LOGGING API
 * ───────────────────────────────────────────── */

/**
 * Log a successful action.
 *
 * @param {string} action      — one of ACTION_TYPES
 * @param {string|null} clientId — target client (null for system-wide)
 * @param {number} durationMs  — elapsed time
 * @param {Object} [metadata]  — additional details
 * @returns {Object} the logged entry
 */
function logAction(action, clientId, durationMs, metadata) {
  if (!initialized) {
    init();
  }

  const entry = buildEntry({
    action,
    clientId,
    result: RESULTS.SUCCESS,
    durationMs,
    metadata,
  });

  writeEntry(entry);
  lastHash = entry.entryHash;
  return entry;
}

/**
 * Log a failed action.
 *
 * @param {string} action      — one of ACTION_TYPES
 * @param {string|null} clientId — target client
 * @param {Error|string} error — the error that caused the failure
 * @param {number} [durationMs] — elapsed time before failure
 * @param {Object} [metadata]  — additional context
 * @returns {Object} the logged entry
 */
function logError(action, clientId, error, durationMs, metadata) {
  if (!initialized) {
    init();
  }

  // Normalize error input
  const errorObj = error instanceof Error
    ? error
    : new Error(typeof error === 'string' ? error : 'Unknown error');

  const entry = buildEntry({
    action,
    clientId,
    result: RESULTS.FAILURE,
    durationMs: durationMs || 0,
    metadata,
    error: errorObj,
  });

  writeEntry(entry);
  lastHash = entry.entryHash;
  return entry;
}

/**
 * Log a warning (action completed but with caveats).
 *
 * @param {string} action      — one of ACTION_TYPES
 * @param {string|null} clientId
 * @param {string} warningMessage — description of the warning
 * @param {number} [durationMs]
 * @param {Object} [metadata]
 * @returns {Object} the logged entry
 */
function logWarning(action, clientId, warningMessage, durationMs, metadata) {
  if (!initialized) {
    init();
  }

  const entry = buildEntry({
    action,
    clientId,
    result: RESULTS.WARNING,
    durationMs: durationMs || 0,
    metadata: Object.assign({ warning: warningMessage }, metadata || {}),
  });

  writeEntry(entry);
  lastHash = entry.entryHash;
  return entry;
}

/* ─────────────────────────────────────────────
 * HIGH-LEVEL CONVENIENCE WRAPPERS
 * ───────────────────────────────────────────── */

/**
 * Wrap an async function call with automatic logging.
 *
 * Usage:
 *   const result = await logOperation(
 *     'backup_created', clientId,
 *     () => backup.exportFirestore(clientId),
 *     { collections: ['orders', 'inventory'] }
 *   );
 *
 * If the function throws, logError is called automatically.
 * If it succeeds, logAction is called with the measured duration.
 *
 * @param {string} action      — ACTION_TYPES value
 * @param {string|null} clientId
 * @param {Function} fn        — async function to execute
 * @param {Object} [metadata]  — extra metadata to attach to the log entry
 * @returns {Promise<any>} the return value of fn()
 */
async function logOperation(action, clientId, fn, metadata) {
  if (!initialized) {
    init();
  }

  const startTime = Date.now();

  try {
    const result = await fn();
    const durationMs = Date.now() - startTime;

    // Merge any metadata the function returned
    const mergedMeta = Object.assign({}, metadata || {});
    if (result && typeof result === 'object' && result.summary) {
      mergedMeta.summary = result.summary;
    }

    logAction(action, clientId, durationMs, mergedMeta);
    return result;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    logError(action, clientId, error, durationMs, metadata);
    throw error; // re-throw so the caller can handle it
  }
}

/* ─────────────────────────────────────────────
 * CHAIN VERIFICATION
 * ───────────────────────────────────────────── */

/**
 * Verify the integrity of the hash chain.
 * Reads the entire audit log and checks that each entry's prevHash
 * matches the previous entry's entryHash, and that each entryHash
 * is correctly computed.
 *
 * @returns {{
 *   valid: boolean,
 *   totalEntries: number,
 *   brokenLinks: Array<{ line: number, expected: string, found: string }>,
 *   tamperedEntries: Array<{ line: number, computed: string, stored: string }>
 * }}
 */
function verifyChain() {
  const logPath = vault.getAuditLogPath();

  if (!fs.existsSync(logPath)) {
    return { valid: true, totalEntries: 0, brokenLinks: [], tamperedEntries: [] };
  }

  const raw = fs.readFileSync(logPath, 'utf-8');
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const brokenLinks = [];
  const tamperedEntries = [];
  let prevHash = null;

  for (let i = 0; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch (_) {
      brokenLinks.push({
        line: i + 1,
        expected: prevHash || '(genesis)',
        found: '(unparseable)',
      });
      // Can't verify chain across an unparseable entry — reset
      prevHash = null;
      continue;
    }

    // Check chain link
    if (entry.prevHash !== prevHash) {
      brokenLinks.push({
        line: i + 1,
        expected: prevHash,
        found: entry.prevHash,
      });
    }

    // Verify entryHash computation
    const tempEntry = Object.assign({}, entry);
    delete tempEntry.entryHash;
    const jsonWithoutHash = JSON.stringify(tempEntry);
    const hashInput = (entry.prevHash || '') + jsonWithoutHash;
    const computedHash = sha256(hashInput);

    if (entry.entryHash !== computedHash) {
      tamperedEntries.push({
        line: i + 1,
        computed: computedHash,
        stored: entry.entryHash,
      });
    }

    prevHash = entry.entryHash;
  }

  return {
    valid: brokenLinks.length === 0 && tamperedEntries.length === 0,
    totalEntries: lines.length,
    brokenLinks,
    tamperedEntries,
  };
}

/* ─────────────────────────────────────────────
 * QUERY HELPERS
 * ───────────────────────────────────────────── */

/**
 * Read the entire audit log as an array of parsed entry objects.
 * Returns [] if the log doesn't exist.
 *
 * @returns {Object[]}
 */
function readAllEntries() {
  const logPath = vault.getAuditLogPath();

  if (!fs.existsSync(logPath)) {
    return [];
  }

  const raw = fs.readFileSync(logPath, 'utf-8');
  return raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return { _corrupted: true, _raw: line };
      }
    });
}

/**
 * Filter audit log entries by criteria.
 *
 * @param {Object} filters
 * @param {string} [filters.clientId]  — exact client ID match
 * @param {string} [filters.action]    — exact action type match
 * @param {Date|string} [filters.since] — entries on or after this time
 * @param {Date|string} [filters.until] — entries on or before this time
 * @param {string} [filters.result]    — "success" | "failure" | "warning"
 * @param {number} [filters.limit]     — max entries to return (most recent first)
 * @returns {Object[]}
 */
function queryEntries({ clientId, action, since, until, result, limit } = {}) {
  let entries = readAllEntries();

  // Filter out corrupted lines
  entries = entries.filter(e => !e._corrupted);

  if (clientId) {
    entries = entries.filter(e => e.clientId === clientId);
  }

  if (action) {
    entries = entries.filter(e => e.action === action);
  }

  if (result) {
    entries = entries.filter(e => e.result === result);
  }

  if (since) {
    const sinceDate = since instanceof Date ? since : new Date(since);
    entries = entries.filter(e => new Date(e.timestamp) >= sinceDate);
  }

  if (until) {
    const untilDate = until instanceof Date ? until : new Date(until);
    entries = entries.filter(e => new Date(e.timestamp) <= untilDate);
  }

  // Sort newest first
  entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  if (limit && limit > 0) {
    entries = entries.slice(0, limit);
  }

  return entries;
}

/* ─────────────────────────────────────────────
 * STATISTICS
 * ───────────────────────────────────────────── */

/**
 * Compute summary statistics from the audit log.
 *
 * @returns {{
 *   totalEntries: number,
 *   successCount: number,
 *   failureCount: number,
 *   warningCount: number,
 *   firstEntryTimestamp: string|null,
 *   lastEntryTimestamp: string|null,
 *   uniqueClients: string[],
 *   uniqueActions: string[],
 *   chainValid: boolean
 * }}
 */
function getStatistics() {
  const entries = readAllEntries().filter(e => !e._corrupted);

  if (entries.length === 0) {
    return {
      totalEntries: 0,
      successCount: 0,
      failureCount: 0,
      warningCount: 0,
      firstEntryTimestamp: null,
      lastEntryTimestamp: null,
      uniqueClients: [],
      uniqueActions: [],
      chainValid: true,
    };
  }

  const successCount = entries.filter(e => e.result === RESULTS.SUCCESS).length;
  const failureCount = entries.filter(e => e.result === RESULTS.FAILURE).length;
  const warningCount = entries.filter(e => e.result === RESULTS.WARNING).length;

  const clients = new Set();
  const actions = new Set();
  for (const e of entries) {
    if (e.clientId) clients.add(e.clientId);
    if (e.action) actions.add(e.action);
  }

  const chain = verifyChain();

  return {
    totalEntries: entries.length,
    successCount,
    failureCount,
    warningCount,
    firstEntryTimestamp: entries[entries.length - 1].timestamp, // oldest (sorted asc by file order)
    lastEntryTimestamp: entries[0].timestamp,                    // newest
    uniqueClients: Array.from(clients).sort(),
    uniqueActions: Array.from(actions).sort(),
    chainValid: chain.valid,
  };
}

/* ─────────────────────────────────────────────
 * EXPORTS
 * ───────────────────────────────────────────── */

module.exports = {
  // Lifecycle
  init,

  // Core logging
  logAction,
  logError,
  logWarning,
  logOperation,

  // Entry building (exposed for advanced use)
  buildEntry,

  // Chain verification
  verifyChain,

  // Querying
  readAllEntries,
  queryEntries,
  getStatistics,

  // Constants
  ACTION_TYPES,
  RESULTS,
};