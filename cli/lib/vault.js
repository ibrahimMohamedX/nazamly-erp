/**
 * cli/lib/vault.js — External Vault I/O
 * =====================================
 * All client configuration (.env files) live OUTSIDE the source repository
 * at `../nazamly-clients-vault/<clientId>/.env`. This module provides the
 * canonical read/write/list/validate API that every CLI script uses.
 *
 * Vault layout:
 *   ../nazamly-clients-vault/
 *     _audit/               ← JSONL audit trail (written by logger.js)
 *     _templates/           ← optional .env template files
 *     <client-id>/
 *       .env                ← 14 key=value lines (Firebase keys + metadata)
 *       deploy-history.json ← appended by deployer.js on each deploy
 *       backups/            ← timestamped Firestore export JSON files
 *       tombstone.json      ← written by destroy.js on decommission
 *
 * .env schema (14 keys):
 *   CLIENT_ID          = elnour
 *   CLIENT_BRAND       = شركة النور
 *   CLIENT_DOMAIN      = elnour.example.com  (optional)
 *   SUPPORT_PHONE      = 201234567890        (optional, for WhatsApp link)
 *   ADMIN_EMAIL        = admin@elnour.com
 *   ADMIN_PASSWORD     = ****
 *   DEPLOY_TARGET      = production | staging
 *   SUBSCRIPTION_MONTHS = 12
 *   FIREBASE_API_KEY   = AIzaSy...
 *   FIREBASE_AUTH_DOMAIN = elnour-erp.firebaseapp.com
 *   FIREBASE_PROJECT_ID  = elnour-erp-abc12
 *   FIREBASE_STORAGE_BUCKET = elnour-erp.appspot.com
 *   FIREBASE_MSG_SENDER_ID = 123456789
 *   FIREBASE_APP_ID     = 1:123456789:web:abcdef...
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/* ─────────────────────────────────────────────
 * PATH RESOLUTION
 * ───────────────────────────────────────────── */

/**
 * Resolve the vault root directory.
 * Always `../nazamly-clients-vault/` relative to the ERP project root.
 * The project root is derived from this very file's location:
 *   cli/lib/vault.js → .. → .. → project root
 * @returns {string} absolute path to the vault root
 */
function resolveVaultRoot() {
  // __dirname = d:\Job\nazamly-erp\cli\lib
  // go up 2 levels  = d:\Job\nazamly-erp  (project root)
  const projectRoot = path.resolve(__dirname, '..', '..');
  // vault is SIBLING, not child
  return path.resolve(projectRoot, '..', 'nazamly-clients-vault');
}

const VAULT_ROOT = resolveVaultRoot();

/**
 * Get the absolute path to a client's directory inside the vault.
 * @param {string} clientId
 * @returns {string} path like `../nazamly-clients-vault/elnour/`
 */
function getClientDir(clientId) {
  if (!clientId || typeof clientId !== 'string') {
    throw new Error('clientId is required');
  }
  return path.join(VAULT_ROOT, sanitizeClientId(clientId));
}

/**
 * Get the absolute path to a client's .env file.
 * @param {string} clientId
 * @returns {string} path like `../nazamly-clients-vault/elnour/.env`
 */
function getEnvPath(clientId) {
  return path.join(getClientDir(clientId), '.env');
}

/**
 * Get the absolute path to a client's deploy history file.
 * @param {string} clientId
 * @returns {string}
 */
function getDeployHistoryPath(clientId) {
  return path.join(getClientDir(clientId), 'deploy-history.json');
}

/**
 * Get the absolute path to a client's backups directory.
 * @param {string} clientId
 * @returns {string}
 */
function getBackupsDir(clientId) {
  return path.join(getClientDir(clientId), 'backups');
}

/**
 * Get the absolute path to the audit log file.
 * @returns {string}
 */
function getAuditLogPath() {
  return path.join(VAULT_ROOT, '_audit', 'audit.log');
}

/* ─────────────────────────────────────────────
 * VALIDATION
 * ───────────────────────────────────────────── */

const CLIENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$/i;

/**
 * Validate and normalize a client ID.
 * Allowed: alphanumeric + hyphens, 2-30 chars, starts/ends with alphanumeric.
 * @param {string} rawId
 * @returns {string} lowercased, trimmed ID
 */
function sanitizeClientId(rawId) {
  const trimmed = String(rawId || '').trim().toLowerCase();
  if (!CLIENT_ID_RE.test(trimmed)) {
    throw new Error(
      `Invalid client ID "${trimmed}". Must be 2-30 characters, alphanumeric ` +
      `plus hyphens, and start/end with a letter or number.`
    );
  }
  return trimmed;
}

/* ─────────────────────────────────────────────
 * .env SCHEMA
 * ───────────────────────────────────────────── */

/**
 * Ordered list of all recognized .env keys with their descriptions.
 * Used for validation, prompting, and documentation.
 */
const ENV_SCHEMA = [
  { key: 'CLIENT_ID',            required: true,  desc: 'Client identifier (alphanumeric + hyphens)' },
  { key: 'CLIENT_BRAND',         required: true,  desc: 'Arabic/display brand name for the client' },
  { key: 'CLIENT_DOMAIN',        required: false, desc: 'Custom domain for Firebase Hosting' },
  { key: 'SUPPORT_PHONE',        required: false, desc: 'WhatsApp support number (international format)' },
  { key: 'ADMIN_EMAIL',          required: true,  desc: 'Client admin account email' },
  { key: 'ADMIN_PASSWORD',       required: true,  desc: 'Client admin account password' },
  { key: 'DEPLOY_TARGET',        required: false, desc: 'production (default) | staging' },
  { key: 'SUBSCRIPTION_MONTHS',  required: true,  desc: 'Initial subscription duration (1/3/6/12)' },
  { key: 'FIREBASE_API_KEY',     required: true,  desc: 'Firebase Web API key' },
  { key: 'FIREBASE_AUTH_DOMAIN', required: true,  desc: 'Firebase Auth domain (project.firebaseapp.com)' },
  { key: 'FIREBASE_PROJECT_ID',  required: true,  desc: 'Firebase project ID' },
  { key: 'FIREBASE_STORAGE_BUCKET', required: true, desc: 'Firebase Storage bucket (project.appspot.com)' },
  { key: 'FIREBASE_MSG_SENDER_ID', required: true, desc: 'Firebase Cloud Messaging sender ID' },
  { key: 'FIREBASE_APP_ID',      required: true,  desc: 'Firebase Web App ID (1:xxxx:web:xxxx)' },
];

/**
 * Keys that are considered sensitive (passwords, keys).
 * Used for masking in log/debug output.
 */
const SENSITIVE_KEYS = new Set([
  'ADMIN_PASSWORD',
  'FIREBASE_API_KEY',
  'FIREBASE_MSG_SENDER_ID',
]);

/* ─────────────────────────────────────────────
 * READ / PARSE .env
 * ───────────────────────────────────────────── */

/**
 * Parse a raw .env string into a key-value object.
 * Handles:
 *   - KEY=VALUE  (standard)
 *   - KEY="value with spaces"
 *   - KEY='value with spaces'
 *   - Blank lines and # comments (ignored)
 *   - Inline # after a value (treated as literal if inside quotes)
 *
 * @param {string} raw — raw .env file content
 * @returns {Object} key-value map
 */
function parseEnv(raw) {
  const result = {};
  const lines = raw.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();

    // Skip blank lines and full-line comments
    if (!line || line.startsWith('#')) continue;

    // Find first = (key cannot contain =)
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue; // malformed line, skip

    const key = line.substring(0, eqIdx).trim();
    let value = line.substring(eqIdx + 1).trim();

    // Strip surrounding single or double quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Remove trailing inline comment (simplistic: # after space outside quotes)
    // We do NOT strip # from quoted values — those are literal.
    // For safety, only strip if the value was NOT quoted and contains " #"
    const originalValue = line.substring(eqIdx + 1).trim();
    if (!((originalValue.startsWith('"') && originalValue.endsWith('"')) ||
          (originalValue.startsWith("'") && originalValue.endsWith("'")))) {
      const commentIdx = value.indexOf(' #');
      if (commentIdx !== -1) {
        value = value.substring(0, commentIdx).trim();
      }
    }

    result[key] = value;
  }

  return result;
}

/**
 * Serialize a key-value object back to a .env string.
 * Keys are written in ENV_SCHEMA order (known keys first), then any extras.
 * Sensitive keys get a comment warning.
 *
 * @param {Object} data
 * @returns {string} .env file content
 */
function serializeEnv(data) {
  const lines = [];
  const written = new Set();

  // Header
  lines.push('# Nazamly ERP — Client Configuration');
  lines.push(`# Client: ${data.CLIENT_ID || 'UNKNOWN'}`);
  lines.push(`# Generated: ${new Date().toISOString()}`);
  lines.push('# ⚠️  DO NOT COMMIT THIS FILE TO VERSION CONTROL');
  lines.push('# ⚠️  This file is stored OUTSIDE the source repository.');
  lines.push('');

  // Write known keys in schema order
  for (const { key } of ENV_SCHEMA) {
    if (data[key] !== undefined && data[key] !== null) {
      if (SENSITIVE_KEYS.has(key)) {
        lines.push(`# 🔒 SENSITIVE — do not share`);
      }
      lines.push(`${key}=${data[key]}`);
      lines.push('');
      written.add(key);
    }
  }

  // Write any extra keys not in the schema (preserved for forward compat)
  const extras = Object.keys(data).filter(k => !written.has(k));
  if (extras.length > 0) {
    lines.push('# Additional / custom fields');
    for (const key of extras.sort()) {
      if (SENSITIVE_KEYS.has(key)) {
        lines.push(`# 🔒 SENSITIVE — do not share`);
      }
      lines.push(`${key}=${data[key]}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/* ─────────────────────────────────────────────
 * PUBLIC API
 * ───────────────────────────────────────────── */

/**
 * Read a client's .env file and return parsed key-value object.
 * @param {string} clientId
 * @returns {Object} parsed env data (empty if file missing)
 */
function readEnv(clientId) {
  const envPath = getEnvPath(clientId);
  if (!fs.existsSync(envPath)) {
    return {};
  }
  const raw = fs.readFileSync(envPath, 'utf-8');
  const parsed = parseEnv(raw);
  // Ensure CLIENT_ID is always set (from directory name)
  parsed.CLIENT_ID = clientId;
  return parsed;
}

/**
 * Write a key-value object to a client's .env file.
 * Creates the client directory if it doesn't exist.
 * @param {string} clientId
 * @param {Object} data
 */
function writeEnv(clientId, data) {
  const clientDir = getClientDir(clientId);
  const envPath = getEnvPath(clientId);

  // Ensure CLIENT_ID is baked into the data
  data.CLIENT_ID = clientId;

  // Create directory if missing
  if (!fs.existsSync(clientDir)) {
    fs.mkdirSync(clientDir, { recursive: true });
  }

  const content = serializeEnv(data);
  fs.writeFileSync(envPath, content, 'utf-8');
}

/**
 * Check whether a client directory with a .env file exists.
 * @param {string} clientId
 * @returns {boolean}
 */
function clientExists(clientId) {
  return fs.existsSync(getEnvPath(clientId));
}

/**
 * List all client IDs that have .env files in the vault.
 * @returns {string[]} sorted array of client IDs
 */
function listClients() {
  if (!fs.existsSync(VAULT_ROOT)) {
    return [];
  }

  const entries = fs.readdirSync(VAULT_ROOT, { withFileTypes: true });
  const clientIds = [];

  for (const entry of entries) {
    // Only directories (not files like _audit, _templates, .gitkeep)
    if (!entry.isDirectory()) continue;
    // Skip system directories (prefixed with _)
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    // Must have a .env file inside
    if (fs.existsSync(path.join(VAULT_ROOT, entry.name, '.env'))) {
      clientIds.push(entry.name);
    }
  }

  return clientIds.sort();
}

/**
 * Get the vault root path (for informational use).
 * @returns {string}
 */
function getVaultRoot() {
  return VAULT_ROOT;
}

/**
 * Ensure the vault root and its system subdirectories exist.
 * Idempotent — safe to call at startup.
 */
function ensureVaultExists() {
  if (!fs.existsSync(VAULT_ROOT)) {
    fs.mkdirSync(VAULT_ROOT, { recursive: true });
  }
  const auditDir = path.join(VAULT_ROOT, '_audit');
  if (!fs.existsSync(auditDir)) {
    fs.mkdirSync(auditDir, { recursive: true });
  }
  const templatesDir = path.join(VAULT_ROOT, '_templates');
  if (!fs.existsSync(templatesDir)) {
    fs.mkdirSync(templatesDir, { recursive: true });
  }
}

/**
 * Quick validation of a parsed .env object.
 * Checks that all required keys are present and non-empty.
 * Returns an array of human-readable error messages (empty = valid).
 *
 * @param {Object} envData
 * @returns {string[]} error messages
 */
function validateEnvData(envData) {
  const errors = [];

  // Validate CLIENT_ID format first
  try {
    sanitizeClientId(envData.CLIENT_ID);
  } catch (e) {
    errors.push(e.message);
  }

  for (const { key, required } of ENV_SCHEMA) {
    if (!required) continue;
    const val = envData[key];
    if (val === undefined || val === null || String(val).trim() === '') {
      errors.push(`Missing required field: ${key}`);
    }
  }

  // Validate SUBSCRIPTION_MONTHS is a positive integer
  const months = parseInt(envData.SUBSCRIPTION_MONTHS, 10);
  if (isNaN(months) || months < 1 || months > 120) {
    errors.push('SUBSCRIPTION_MONTHS must be an integer between 1 and 120');
  }

  // Validate DEPLOY_TARGET if present
  if (envData.DEPLOY_TARGET && !['production', 'staging'].includes(envData.DEPLOY_TARGET)) {
    errors.push('DEPLOY_TARGET must be "production" or "staging"');
  }

  // Validate FIREBASE_APP_ID format (should be 1:NNNN:web:XXXX)
  if (envData.FIREBASE_APP_ID && !/^1:\d+:web:[a-f0-9]+$/i.test(envData.FIREBASE_APP_ID.trim())) {
    errors.push('FIREBASE_APP_ID format looks wrong. Expected: 1:NNNNNN:web:XXXXX');
  }

  // Validate FIREBASE_API_KEY starts with AIza
  if (envData.FIREBASE_API_KEY && !envData.FIREBASE_API_KEY.trim().startsWith('AIza')) {
    errors.push('FIREBASE_API_KEY should start with "AIza" (Firebase Web API keys always do)');
  }

  return errors;
}

/**
 * Get the schema definition (used by validator.js and prompts).
 * @returns {Array}
 */
function getSchema() {
  return ENV_SCHEMA;
}

/**
 * Get the set of sensitive key names.
 * @returns {Set<string>}
 */
function getSensitiveKeys() {
  return SENSITIVE_KEYS;
}

/* ─────────────────────────────────────────────
 * ENCRYPTION — AES-256-GCM
 * ───────────────────────────────────────────── */

/**
 * Encryption constants.
 *
 * ALGORITHM: AES-256-GCM (authenticated encryption)
 *   - Key derived via PBKDF2 (SHA-512, 210 000 iterations) from the passphrase
 *   - 128-bit auth tag (GCM) — tamper detection built in
 *   - 16-byte random IV per encryption (prepended to ciphertext)
 *   - 32-byte random salt per encryption (prepended to IV)
 *
 * FORMAT (base64-encoded):
 *   salt(32) || iv(16) || authTag(16) || ciphertext
 *
 * Detection: an encrypted .env file starts with the header marker:
 *   ### NAZAMLY-ENCRYPTED-V1 ###
 * followed by the base64 blob on the next line.
 */

const ENCRYPTION_MARKER = '### NAZAMLY-ENCRYPTED-V1 ###';
const SALT_LENGTH = 32;      // bytes
const IV_LENGTH = 16;        // bytes (AES block size)
const AUTH_TAG_LENGTH = 16;  // bytes (GCM tag)
const KEY_LENGTH = 32;       // bytes (AES-256)
const PBKDF2_ITERATIONS = 210000;
const PBKDF2_DIGEST = 'sha512';

/**
 * Derive a 256-bit AES key from a passphrase and salt using PBKDF2.
 *
 * @param {string} passphrase
 * @param {Buffer} salt
 * @returns {Buffer} 32-byte key
 */
function deriveKey(passphrase, salt) {
  return crypto.pbkdf2Sync(
    passphrase,
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    PBKDF2_DIGEST
  );
}

/**
 * Encrypt plaintext using AES-256-GCM.
 *
 * @param {string} plaintext — the .env content to encrypt
 * @param {string} passphrase — the master key/passphrase
 * @returns {string} encrypted blob: marker line + base64 payload
 */
function encrypt(plaintext, passphrase) {
  // Generate random salt + IV
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);

  // Derive key
  const key = deriveKey(passphrase, salt);

  // Encrypt
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Pack: salt || iv || authTag || ciphertext
  const payload = Buffer.concat([salt, iv, authTag, encrypted]);

  return ENCRYPTION_MARKER + '\n' + payload.toString('base64');
}

/**
 * Decrypt an encrypted blob back to plaintext.
 *
 * @param {string} encryptedBlob — marker line + base64 payload
 * @param {string} passphrase — the master key/passphrase
 * @returns {{ success: boolean, plaintext?: string, error?: string }}
 */
function decrypt(encryptedBlob, passphrase) {
  // Strip marker line
  const lines = encryptedBlob.split(/\r?\n/);
  if (lines[0].trim() !== ENCRYPTION_MARKER) {
    return { success: false, error: 'Not an encrypted file (missing marker).' };
  }

  const base64 = lines.slice(1).join('').trim();
  if (!base64) {
    return { success: false, error: 'Encrypted file is empty (no payload).' };
  }

  let payload;
  try {
    payload = Buffer.from(base64, 'base64');
  } catch (e) {
    return { success: false, error: `Failed to decode base64 payload: ${e.message}` };
  }

  // Unpack: salt || iv || authTag || ciphertext
  if (payload.length < SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    return { success: false, error: 'Encrypted payload is too short — corrupted.' };
  }

  let offset = 0;
  const salt = payload.subarray(offset, offset + SALT_LENGTH); offset += SALT_LENGTH;
  const iv = payload.subarray(offset, offset + IV_LENGTH); offset += IV_LENGTH;
  const authTag = payload.subarray(offset, offset + AUTH_TAG_LENGTH); offset += AUTH_TAG_LENGTH;
  const ciphertext = payload.subarray(offset);

  // Derive key
  const key = deriveKey(passphrase, salt);

  // Decrypt
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf-8');

    return { success: true, plaintext };
  } catch (e) {
    return {
      success: false,
      error: `Decryption failed: ${e.message}. ` +
             `This usually means the passphrase is wrong or the file was tampered with.`,
    };
  }
}

/**
 * Check whether a raw .env file content is encrypted.
 * @param {string} raw — file content
 * @returns {boolean}
 */
function isEncrypted(raw) {
  return raw.trimStart().startsWith(ENCRYPTION_MARKER);
}

/* ─────────────────────────────────────────────
 * MASTER KEY MANAGEMENT (.vault-key)
 * ───────────────────────────────────────────── */

/**
 * Path to the master key file.
 * Stored at the vault root: ../nazamly-clients-vault/.vault-key
 *
 * The file contains ONLY the passphrase on line 1.
 * Permissions should be 600 (owner read/write only).
 * The file is gitignored and NEVER committed.
 */
const VAULT_KEY_PATH = path.join(VAULT_ROOT, '.vault-key');

/**
 * In-memory cache of the master passphrase.
 * Set once via setMasterKey() and reused transparently by readEnv/writeEnv.
 * NULL means "no key set — operate in plaintext mode".
 * @type {string|null}
 */
let _masterPassphrase = null;

/**
 * Whether the master key was loaded from the .vault-key file (true)
 * or set interactively/explicitly (false).
 * @type {boolean}
 */
let _keyFromFile = false;

/**
 * Set the master passphrase in memory.
 * Call this once at startup if encryption is desired.
 *
 * @param {string} passphrase
 * @param {{ persist?: boolean }} [options]
 *   - persist: if true, write the passphrase to .vault-key for future sessions
 * @returns {{ success: boolean, error?: string }}
 */
function setMasterKey(passphrase, options = {}) {
  if (!passphrase || typeof passphrase !== 'string' || passphrase.trim().length === 0) {
    return { success: false, error: 'Passphrase must be a non-empty string.' };
  }

  if (passphrase.length < 12) {
    return { success: false, error: 'Passphrase must be at least 12 characters for security.' };
  }

  _masterPassphrase = passphrase.trim();
  _keyFromFile = false;

  // Optionally persist to disk
  if (options.persist) {
    try {
      ensureVaultExists();
      fs.writeFileSync(VAULT_KEY_PATH, _masterPassphrase, {
        encoding: 'utf-8',
        mode: 0o600, // owner read/write only
      });
    } catch (e) {
      return { success: false, error: `Failed to write .vault-key: ${e.message}` };
    }
  }

  return { success: true };
}

/**
 * Get the current master passphrase.
 * If not yet set AND the .vault-key file exists, auto-load it.
 * Returns null if no key is available (plaintext mode).
 *
 * @returns {{ success: boolean, key?: string|null, fromFile?: boolean, error?: string }}
 */
function getMasterKey() {
  // Already in memory
  if (_masterPassphrase !== null) {
    return { success: true, key: _masterPassphrase, fromFile: _keyFromFile };
  }

  // Try to auto-load from .vault-key file
  if (fs.existsSync(VAULT_KEY_PATH)) {
    try {
      const raw = fs.readFileSync(VAULT_KEY_PATH, 'utf-8');
      const passphrase = raw.split(/\r?\n/)[0].trim();
      if (passphrase) {
        _masterPassphrase = passphrase;
        _keyFromFile = true;
        return { success: true, key: passphrase, fromFile: true };
      }
    } catch (e) {
      return { success: false, key: null, error: `Failed to read .vault-key: ${e.message}` };
    }
  }

  // No key available — plaintext mode
  return { success: true, key: null, fromFile: false };
}

/**
 * Check whether a master key is currently active (in memory or on disk).
 * @returns {boolean}
 */
function hasMasterKey() {
  const result = getMasterKey();
  return result.success && result.key !== null;
}

/**
 * Clear the in-memory master key (for cleanup/explicit reset).
 */
function clearMasterKey() {
  _masterPassphrase = null;
  _keyFromFile = false;
}

/**
 * Get the path to the .vault-key file.
 * @returns {string}
 */
function getVaultKeyPath() {
  return VAULT_KEY_PATH;
}

/**
 * One-shot resolver for CLI scripts to call early in main().
 *
 * Handles the three sources of the master passphrase in priority order:
 *   1. --key <passphrase>      — explicit passphrase on command line
 *   2. --key-file <path>       — file containing the passphrase (first line)
 *   3. .vault-key auto-load   — file at vault root (if it exists)
 *
 * If none are available, operates in plaintext mode (no error).
 *
 * Usage in a CLI script:
 *   const keyResult = vault.resolveMasterKey({ flag: options.key, file: options.keyFile });
 *   if (!keyResult.success) {
 *     console.error(chalk.red(`✖ ${keyResult.error}`));
 *     process.exit(1);
 *   }
 *   // keyResult.mode is 'encrypted' or 'plaintext'
 *
 * @param {{ flag?: string|null, file?: string|null }} sources
 * @returns {{ success: boolean, mode: 'encrypted'|'plaintext', source?: 'flag'|'file'|'disk'|'none', error?: string }}
 */
function resolveMasterKey(sources = {}) {
  const { flag, file } = sources;

  // 1. --key <passphrase> — explicit passphrase (highest priority)
  if (flag && typeof flag === 'string' && flag.trim().length > 0) {
    const result = setMasterKey(flag.trim());
    if (!result.success) {
      return { success: false, mode: 'plaintext', error: result.error };
    }
    return { success: true, mode: 'encrypted', source: 'flag' };
  }

  // 2. --key-file <path> — read passphrase from file
  if (file && typeof file === 'string') {
    try {
      const fs = require('fs');
      const filePath = require('path').resolve(file.trim());
      if (!fs.existsSync(filePath)) {
        return { success: false, mode: 'plaintext', error: `Key file not found: ${filePath}` };
      }
      const raw = fs.readFileSync(filePath, 'utf-8');
      const passphrase = raw.split(/\r?\n/)[0].trim();
      if (!passphrase) {
        return { success: false, mode: 'plaintext', error: `Key file is empty: ${filePath}` };
      }
      const result = setMasterKey(passphrase);
      if (!result.success) {
        return { success: false, mode: 'plaintext', error: result.error };
      }
      return { success: true, mode: 'encrypted', source: 'file' };
    } catch (e) {
      return { success: false, mode: 'plaintext', error: `Failed to read key file: ${e.message}` };
    }
  }

  // 3. Auto-load from .vault-key file
  const keyResult = getMasterKey();
  if (keyResult.key) {
    return { success: true, mode: 'encrypted', source: 'disk' };
  }

  // 4. No key available — plaintext mode
  return { success: true, mode: 'plaintext', source: 'none' };
}

/* ─────────────────────────────────────────────
 * UPGRADED readEnv / writeEnv — ENCRYPTION-AWARE
 * ───────────────────────────────────────────── */

/**
 * Read a client's .env file, transparently decrypting if encrypted.
 *
 * Behavior:
 *   - If file is encrypted AND master key is available → decrypt → parse
 *   - If file is encrypted AND no master key → return { _encrypted: true } with error info
 *   - If file is plaintext → parse normally (backward compatible)
 *   - If file is missing → return {}
 *
 * @param {string} clientId
 * @returns {Object} parsed env data. May include _encrypted:true if locked.
 */
function readEnvTransparent(clientId) {
  const envPath = getEnvPath(clientId);
  if (!fs.existsSync(envPath)) {
    return {};
  }

  const raw = fs.readFileSync(envPath, 'utf-8');

  if (isEncrypted(raw)) {
    const keyResult = getMasterKey();
    if (!keyResult.key) {
      return {
        _encrypted: true,
        _error: 'No master key available. Provide --key or create .vault-key file.',
        _envPath: envPath,
        CLIENT_ID: clientId,
      };
    }

    const decResult = decrypt(raw, keyResult.key);
    if (!decResult.success) {
      return {
        _encrypted: true,
        _error: decResult.error,
        _envPath: envPath,
        CLIENT_ID: clientId,
      };
    }

    const parsed = parseEnv(decResult.plaintext);
    parsed.CLIENT_ID = clientId;
    return parsed;
  }

  // Plaintext — backward compatible
  const parsed = parseEnv(raw);
  parsed.CLIENT_ID = clientId;
  return parsed;
}

/**
 * Write a key-value object to a client's .env file, transparently encrypting
 * if a master key is active.
 *
 * Behavior:
 *   - If master key is active → serialize → encrypt → write
 *   - If no master key → serialize → write plaintext (backward compatible)
 *   - Creates the client directory if it doesn't exist.
 *
 * @param {string} clientId
 * @param {Object} data
 * @returns {{ success: boolean, encrypted?: boolean, error?: string }}
 */
function writeEnvTransparent(clientId, data) {
  const clientDir = getClientDir(clientId);
  const envPath = getEnvPath(clientId);

  // Ensure CLIENT_ID is baked into the data
  data.CLIENT_ID = clientId;

  // Create directory if missing
  if (!fs.existsSync(clientDir)) {
    fs.mkdirSync(clientDir, { recursive: true });
  }

  const plaintext = serializeEnv(data);
  const keyResult = getMasterKey();

  let content;
  let encrypted = false;

  if (keyResult.key) {
    try {
      content = encrypt(plaintext, keyResult.key);
      encrypted = true;
    } catch (e) {
      return { success: false, error: `Encryption failed: ${e.message}` };
    }
  } else {
    content = plaintext;
    encrypted = false;
  }

  try {
    fs.writeFileSync(envPath, content, 'utf-8');
    return { success: true, encrypted };
  } catch (e) {
    return { success: false, error: `Failed to write .env: ${e.message}` };
  }
}

/**
 * Encrypt a specific client's .env file that is currently in plaintext.
 * Used to retroactively encrypt existing clients after setting up a master key.
 *
 * Reads the plaintext .env, encrypts it, and writes it back.
 *
 * @param {string} clientId
 * @param {string} passphrase
 * @returns {{ success: boolean, error?: string }}
 */
function encryptEnv(clientId, passphrase) {
  const envPath = getEnvPath(clientId);

  if (!fs.existsSync(envPath)) {
    return { success: false, error: `No .env file found for client "${clientId}".` };
  }

  const raw = fs.readFileSync(envPath, 'utf-8');

  // Don't double-encrypt
  if (isEncrypted(raw)) {
    return { success: false, error: `.env for "${clientId}" is already encrypted.` };
  }

  try {
    const encrypted = encrypt(raw, passphrase);
    fs.writeFileSync(envPath, encrypted, 'utf-8');
    return { success: true };
  } catch (e) {
    return { success: false, error: `Failed to encrypt .env: ${e.message}` };
  }
}

/**
 * Decrypt a specific client's .env file back to plaintext.
 * Used when removing encryption or migrating keys.
 *
 * @param {string} clientId
 * @param {string} passphrase
 * @returns {{ success: boolean, error?: string }}
 */
function decryptEnv(clientId, passphrase) {
  const envPath = getEnvPath(clientId);

  if (!fs.existsSync(envPath)) {
    return { success: false, error: `No .env file found for client "${clientId}".` };
  }

  const raw = fs.readFileSync(envPath, 'utf-8');

  if (!isEncrypted(raw)) {
    return { success: false, error: `.env for "${clientId}" is not encrypted.` };
  }

  const result = decrypt(raw, passphrase);
  if (!result.success) {
    return result; // { success: false, error }
  }

  try {
    fs.writeFileSync(envPath, result.plaintext, 'utf-8');
    return { success: true };
  } catch (e) {
    return { success: false, error: `Failed to write decrypted .env: ${e.message}` };
  }
}

/**
 * Re-encrypt a client's .env with a new passphrase.
 * Decrypts with the old passphrase, then encrypts with the new one.
 *
 * @param {string} clientId
 * @param {string} oldPassphrase
 * @param {string} newPassphrase
 * @returns {{ success: boolean, error?: string }}
 */
function reencryptEnv(clientId, oldPassphrase, newPassphrase) {
  const envPath = getEnvPath(clientId);

  if (!fs.existsSync(envPath)) {
    return { success: false, error: `No .env file found for client "${clientId}".` };
  }

  const raw = fs.readFileSync(envPath, 'utf-8');

  if (!isEncrypted(raw)) {
    return { success: false, error: `.env for "${clientId}" is not encrypted.` };
  }

  // Decrypt with old key
  const decResult = decrypt(raw, oldPassphrase);
  if (!decResult.success) {
    return decResult; // { success: false, error }
  }

  // Encrypt with new key
  try {
    const encrypted = encrypt(decResult.plaintext, newPassphrase);
    fs.writeFileSync(envPath, encrypted, 'utf-8');
    return { success: true };
  } catch (e) {
    return { success: false, error: `Failed to re-encrypt .env: ${e.message}` };
  }
}

/**
 * Encrypt all plaintext .env files in the vault using the active master key.
 * Skips already-encrypted files. Reports results per client.
 *
 * @returns {{ success: boolean, results: Array<{clientId: string, success: boolean, error?: string}> }}
 */
function encryptAllClients() {
  const keyResult = getMasterKey();
  if (!keyResult.key) {
    return { success: false, results: [], error: 'No master key available.' };
  }

  const clients = listClients();
  const results = [];

  for (const clientId of clients) {
    const r = encryptEnv(clientId, keyResult.key);
    results.push({ clientId, ...r });
  }

  return {
    success: results.every(r => r.success),
    results,
  };
}

/* ─────────────────────────────────────────────
 * EXPORTS
 * ───────────────────────────────────────────── */

module.exports = {
  // Core I/O (original plaintext — kept for backward compat)
  readEnv,
  writeEnv,

  // Core I/O (encryption-aware — USE THESE from now on)
  readEnvTransparent,
  writeEnvTransparent,

  clientExists,
  listClients,

  // Paths
  getVaultRoot,
  getClientDir,
  getEnvPath,
  getDeployHistoryPath,
  getBackupsDir,
  getAuditLogPath,
  resolveVaultRoot,
  getVaultKeyPath,

  // Utilities
  parseEnv,
  serializeEnv,
  validateEnvData,
  sanitizeClientId,
  getSchema,
  getSensitiveKeys,
  ensureVaultExists,

  // Encryption
  encrypt,
  decrypt,
  encryptEnv,
  decryptEnv,
  reencryptEnv,
  encryptAllClients,
  isEncrypted,

  // Master key
  setMasterKey,
  getMasterKey,
  hasMasterKey,
  clearMasterKey,
  resolveMasterKey,

  // Constants
  VAULT_ROOT,
  ENCRYPTION_MARKER,
};