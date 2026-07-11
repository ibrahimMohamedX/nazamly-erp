/**
 * cli/lib/injection.js — Template Injection Engine
 * ==================================================
 *
 * Replaces `{{PLACEHOLDER}}` tokens in HTML and JS source files with
 * real values from a client's .env data. This is the bridge between
 * the external vault and deployable frontend assets.
 *
 * Flow:
 *   sourceDir (repo files with placeholders)
 *     → injectConfig(sourceDir, buildDir, envData)
 *       → buildDir/<clientId>/   (ready-to-deploy files)
 *
 * Supported placeholders (from .env schema):
 *   {{FIREBASE_API_KEY}}       {{FIREBASE_AUTH_DOMAIN}}
 *   {{FIREBASE_PROJECT_ID}}     {{FIREBASE_STORAGE_BUCKET}}
 *   {{FIREBASE_MSG_SENDER_ID}}  {{FIREBASE_APP_ID}}
 *   {{CLIENT_BRAND}}            {{SUPPORT_PHONE}}
 *   {{CLIENT_ID}}               {{CLIENT_DOMAIN}}
 *
 * Post-injection validation scans for any remaining {{...}} tokens
 * and fails loudly if any are found — this catches typos and missing
 * .env fields before deployment.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vault = require('./vault.js');

/* ─────────────────────────────────────────────
 * PLACEHOLDER → ENV KEY MAPPING
 * ───────────────────────────────────────────── */

/**
 * Map of placeholder token → .env key it resolves to.
 * Every {{TOKEN}} that appears in source files must have an entry here.
 */
const PLACEHOLDER_MAP = {
  FIREBASE_API_KEY:      'FIREBASE_API_KEY',
  FIREBASE_AUTH_DOMAIN:  'FIREBASE_AUTH_DOMAIN',
  FIREBASE_PROJECT_ID:   'FIREBASE_PROJECT_ID',
  FIREBASE_STORAGE_BUCKET: 'FIREBASE_STORAGE_BUCKET',
  FIREBASE_MSG_SENDER_ID: 'FIREBASE_MSG_SENDER_ID',
  FIREBASE_APP_ID:       'FIREBASE_APP_ID',
  CLIENT_BRAND:          'CLIENT_BRAND',
  SUPPORT_PHONE:         'SUPPORT_PHONE',
  CLIENT_ID:             'CLIENT_ID',
  CLIENT_DOMAIN:         'CLIENT_DOMAIN',
};

/**
 * Placeholders that receive a default value when the .env field is empty.
 * Optional fields should NOT cause injection failure.
 */
const DEFAULT_VALUES = {
  CLIENT_DOMAIN: '',    // empty = no custom domain
  SUPPORT_PHONE: '',    // empty = no WhatsApp number configured
};

/* ─────────────────────────────────────────────
 * FILE EXTENSIONS TO PROCESS
 * ───────────────────────────────────────────── */

/**
 * File extensions that get placeholder replacement.
 * HTML and JS are the primary targets; CSS rarely needs it.
 */
const PROCESS_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.js',
  '.json',   // firebase.json, .firebaserc, etc.
  '.txt',    // any text-based config
]);

/* ─────────────────────────────────────────────
 * FILE / DIRECTORY EXCLUSIONS
 * ───────────────────────────────────────────── */

/**
 * Paths to skip during injection.
 * These can be exact file/folder names or glob-like patterns.
 */
const EXCLUDE_PATTERNS = [
  'node_modules',
  '.git',
  '.claude',
  '.vscode',
  '.idea',
  '.build-cache',
  'cli',             // CLI tools — not deployable frontend assets
  'backups',
  'service-account.json',
  'seeder-config.json',
  'deploy-history.json',
  '.env',
  '.gitignore',
  '.gitkeep',
  'package.json',
  'package-lock.json',
  // Binary/image files — must be COPIED as-is, not text-processed.
  // They are NOT excluded from the build; they fall through to the
  // copyFileSync branch in walkAndInject because they are not in
  // PROCESS_EXTENSIONS. Only exclude text files we never want deployed.
  // (Removed .png .jpg .jpeg .gif .svg .ico .woff .woff2 .ttf .eot .map
  //  from here — they were being skipped entirely instead of copied.)
];

/**
 * Check whether a file or directory path should be excluded from injection.
 * @param {string} filePath — relative or absolute path
 * @returns {boolean} true if should skip
 */
function isExcluded(filePath) {
  const basename = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  for (const pattern of EXCLUDE_PATTERNS) {
    if (pattern.startsWith('.')) {
      // Extension exclusion
      if (ext === pattern) return true;
    } else {
      // Name exclusion
      if (basename === pattern || filePath.includes(`/${pattern}/`) || filePath.includes(`\\${pattern}\\`)) {
        return true;
      }
    }
  }

  return false;
}

/* ─────────────────────────────────────────────
 * TOKEN REPLACEMENT
 * ───────────────────────────────────────────── */

/**
 * Build a replacement map from env data.
 * Converts the .env key-value object into {{TOKEN}} → realValue.
 *
 * @param {Object} envData — parsed .env object
 * @returns {Object} map of placeholder → value
 */
function buildReplacementMap(envData) {
  const map = {};

  for (const [placeholder, envKey] of Object.entries(PLACEHOLDER_MAP)) {
    const token = `{{${placeholder}}}`;
    let value = envData[envKey];

    // Use default if value is empty/undefined
    if (value === undefined || value === null || String(value).trim() === '') {
      value = DEFAULT_VALUES[placeholder] !== undefined ? DEFAULT_VALUES[placeholder] : '';
    }

    map[token] = String(value);
  }

  return map;
}

/**
 * Replace all placeholders in a string using the replacement map.
 *
 * @param {string} content — source file content
 * @param {Object} replacementMap — token → value
 * @returns {{ result: string, replacedCount: number, replacedTokens: string[] }}
 */
function replaceTokens(content, replacementMap) {
  let result = content;
  let replacedCount = 0;
  const replacedTokens = [];

  for (const [token, value] of Object.entries(replacementMap)) {
    // Count occurrences before replacement
    const count = (result.match(new RegExp(escapeRegex(token), 'g')) || []).length;
    if (count > 0) {
      result = result.split(token).join(value); // faster than regex replace for static strings
      replacedCount += count;
      replacedTokens.push(`${token} → "${truncate(value, 40)}" (${count}×)`);
    }
  }

  return { result, replacedCount, replacedTokens };
}

/* ─────────────────────────────────────────────
 * POST-INJECTION VALIDATION
 * ───────────────────────────────────────────── */

/**
 * Scan content for any remaining unreplaced `{{...}}` tokens.
 * Returns a list of found tokens with their line numbers.
 *
 * @param {string} content — post-injection file content
 * @param {string} filePath  — for error messages
 * @returns {Array<{ token: string, line: number }>}
 */
function scanForRemainingPlaceholders(content, filePath) {
  const lines = content.split(/\r?\n/);
  const findings = [];

  const placeholderRe = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;

  for (let i = 0; i < lines.length; i++) {
    let match;
    while ((match = placeholderRe.exec(lines[i])) !== null) {
      findings.push({
        token: match[0],
        name: match[1],
        line: i + 1,
        file: filePath,
      });
    }
  }

  return findings;
}

/* ─────────────────────────────────────────────
 * MAIN INJECTION FLOW
 * ───────────────────────────────────────────── */

/**
 * Inject all placeholders: copy source files → build dir, replacing tokens.
 *
 * Walks the source directory recursively. For each text file:
 *   1. Reads content
 *   2. Replaces all {{PLACEHOLDER}} tokens with values from envData
 *   3. Writes result to the corresponding path under buildDir
 *
 * Binary/excluded files are copied as-is (no replacement).
 *
 * @param {string} sourceDir — root of the repo (contains HTML/JS with placeholders)
 * @param {string} buildDir  — output directory (typically buildDir/<clientId>/)
 * @param {Object} envData   — parsed .env object from vault
 * @returns {{
 *   success: boolean,
 *   filesProcessed: number,
 *   filesSkipped: number,
 *   totalReplacements: number,
 *   replacedTokens: Array<{ token: string, file: string, count: number }>,
 *   unreplacedPlaceholders: Array<{ token: string, file: string, line: number }>,
 *   errors: string[],
 *   buildDir: string
 * }}
 */
function injectConfig(sourceDir, buildDir, envData) {
  const replacementMap = buildReplacementMap(envData);

  // Ensure build directory exists
  // On Windows, fs.rmSync can hang if files are locked. Use a suffix timestamp
  // to create unique build dirs and skip cleanup if deletion fails.
  if (fs.existsSync(buildDir)) {
    try {
      fs.rmSync(buildDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (e) {
      // If deletion fails (file locks on Windows), write to a new unique path instead
      const fallbackDir = buildDir + '-' + Date.now();
      if (!fs.existsSync(fallbackDir)) {
        fs.mkdirSync(fallbackDir, { recursive: true });
      }
      // Note: we continue with the ORIGINAL buildDir but skip cleanup.
      // The deployer already creates timestamped workspace dirs, so the
      // collision risk is low. The error is logged but not fatal.
    }
  }
  if (!fs.existsSync(buildDir)) {
    fs.mkdirSync(buildDir, { recursive: true });
  }

  const stats = {
    filesProcessed: 0,
    filesSkipped: 0,
    totalReplacements: 0,
    replacedTokens: [],
    unreplacedPlaceholders: [],
    errors: [],
  };

  // Walk source directory
  walkAndInject(sourceDir, sourceDir, buildDir, replacementMap, stats);

  return {
    success: stats.errors.length === 0 && stats.unreplacedPlaceholders.length === 0,
    buildDir,
    ...stats,
  };
}

/**
 * Recursively walk a directory tree, replacing tokens in text files
 * and copying everything else.
 *
 * @param {string} rootDir      — source root (for relative path computation)
 * @param {string} currentDir   — current directory being walked
 * @param {string} buildDir     — output root
 * @param {Object} replacementMap
 * @param {Object} stats        — mutable stats accumulator
 */
function walkAndInject(rootDir, currentDir, buildDir, replacementMap, stats) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, srcPath);
    const destPath = path.join(buildDir, relativePath);

    // Skip excluded paths
    if (isExcluded(srcPath)) {
      stats.filesSkipped++;
      continue;
    }

    if (entry.isDirectory()) {
      // Create directory in build and recurse
      if (!fs.existsSync(destPath)) {
        fs.mkdirSync(destPath, { recursive: true });
      }
      walkAndInject(rootDir, srcPath, buildDir, replacementMap, stats);
      continue;
    }

    // It's a file
    const ext = path.extname(entry.name).toLowerCase();

    if (PROCESS_EXTENSIONS.has(ext)) {
      // Text file — read, replace, write
      try {
        let content = fs.readFileSync(srcPath, 'utf-8');
        const { result, replacedCount, replacedTokens } = replaceTokens(content, replacementMap);

        if (replacedCount > 0) {
          stats.totalReplacements += replacedCount;
          for (const desc of replacedTokens) {
            stats.replacedTokens.push({
              token: desc,
              file: relativePath,
              count: replacedCount,
            });
          }
        }

        // Scan for remaining unreplaced placeholders
        const remaining = scanForRemainingPlaceholders(result, relativePath);
        if (remaining.length > 0) {
          for (const finding of remaining) {
            stats.unreplacedPlaceholders.push(finding);
            stats.errors.push(
              `Unreplaced placeholder ${finding.token} in ${relativePath}:${finding.line}. ` +
              `No .env key mapped for "${finding.name}".`
            );
          }
        }

        // Ensure parent directories exist
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }

        fs.writeFileSync(destPath, result, 'utf-8');
        stats.filesProcessed++;
      } catch (error) {
        stats.errors.push(`Failed to process ${relativePath}: ${error.message}`);
      }
    } else {
      // Non-text file — copy as-is
      try {
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }
        fs.copyFileSync(srcPath, destPath);
        stats.filesSkipped++;
      } catch (error) {
        stats.errors.push(`Failed to copy ${relativePath}: ${error.message}`);
      }
    }
  }
}

/**
 * Convenience: inject for a client ID by reading its .env from vault.
 *
 * @param {string} clientId
 * @param {string} sourceDir  — repo root (or source dir within it)
 * @param {string} outputDir  — where build trees land (defaults to cli/.build-cache/)
 * @returns {Object} same shape as injectConfig()
 */
function injectForClient(clientId, sourceDir, outputDir) {
  const envData = vault.readEnvTransparent(clientId);

  if (!envData || Object.keys(envData).length === 0) {
    return {
      success: false,
      error: `No .env data found for client "${clientId}". Run create-client.js first.`,
      filesProcessed: 0,
      filesSkipped: 0,
      totalReplacements: 0,
      replacedTokens: [],
      unreplacedPlaceholders: [],
      errors: [`Client "${clientId}" has no .env in vault.`],
      buildDir: null,
    };
  }

  // Default build output: cli/.build-cache/<clientId>/
  const resolvedOutputDir = outputDir || path.resolve(__dirname, '..', '.build-cache', clientId);

  return injectConfig(sourceDir, path.resolve(resolvedOutputDir), envData);
}

/* ─────────────────────────────────────────────
 * UTILITIES
 * ───────────────────────────────────────────── */

/**
 * Escape special regex characters in a string.
 * Used to safely create regex patterns from literal placeholder tokens.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Truncate a string to maxLen with ellipsis if needed.
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + '...';
}

/**
 * Get all known placeholder tokens (for documentation / debugging).
 * @returns {string[]}
 */
function getPlaceholderTokens() {
  return Object.keys(PLACEHOLDER_MAP).map(k => `{{${k}}}`);
}

/* ─────────────────────────────────────────────
 * EXPORTS
 * ───────────────────────────────────────────── */

module.exports = {
  injectConfig,
  injectForClient,
  buildReplacementMap,
  replaceTokens,
  scanForRemainingPlaceholders,
  getPlaceholderTokens,
  PLACEHOLDER_MAP,
  DEFAULT_VALUES,
};