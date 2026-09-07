/**
 * cli/lib/deployer.js — Firebase Hosting Deployment Engine
 * ==========================================================
 *
 * Core deployment logic shared by deploy.js and rollback/audit scripts.
 *
 * Responsibilities:
 *   - Generate firebase.json and .firebaserc per-client from vault .env
 *   - Shell out to `npx firebase-tools deploy --only hosting`
 *   - Record each deployment in deploy-history.json
 *   - Support dry-run mode (build only, no deploy)
 *   - Support --all batch mode (iterate all clients)
 *
 * Deployment flow for a single client:
 *   1. Read .env from vault
 *   2. Run injection.js → buildDir with replaced placeholders
 *   3. Generate firebase.json + .firebaserc in a temp Firebase workspace
 *   4. Copy buildDir contents into the workspace's public/ folder
 *   5. Shell out: npx firebase deploy --only hosting --project <projectId>
 *   6. Parse output to capture hosting release version
 *   7. Record entry in deploy-history.json
 *
 * Prerequisites:
 *   - firebase-tools must be installed (npm install -g firebase-tools or npx)
 *   - Operator must be logged in: npx firebase-tools login
 *   - firebase-tools requires the project to exist in Firebase Console already
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const vault = require('./vault.js');
const injection = require('./injection.js');
const logger = require('./logger.js');

/* ─────────────────────────────────────────────
 * CONSTANTS
 * ───────────────────────────────────────────── */

const CLI_DIR = path.resolve(__dirname, '..');
const BUILD_CACHE_DIR = path.join(CLI_DIR, '.build-cache');

/* ─────────────────────────────────────────────
 * FIREBASE PROJECT FILE GENERATION
 * ───────────────────────────────────────────── */

/**
 * Generate a firebase.json config file for a client's hosting deployment.
 *
 * The config tells firebase-tools:
 *   - Which directory to deploy (public/)
 *   - What files to ignore
 *   - Hosting-specific settings (rewrites, headers)
 *
 * @param {string} workspaceDir — root of the temp Firebase workspace
 * @param {Object} envData      — parsed .env object
 * @returns {string} path to the generated firebase.json
 */
function generateFirebaseConfig(workspaceDir, envData) {
  const config = {
    hosting: {
      public: 'public',
      ignore: [
        'firebase.json',
        '.firebaserc',
        '**/.*',
        '**/node_modules/**',
      ],
      rewrites: [
        {
          // Only SPA-route HTML navigation paths — not static assets.
          // Excludes file extensions so real static files (PNG, JS, CSS, etc.)
          // are served directly without falling back to index.html.
          // This prevents browsers from caching SPA fallback HTML responses
          // in place of real asset files that get added in later deploys.
          source: '**/*.@(html)',
          destination: '/index.html',
        },
        {
          // Clean URLs without extensions (e.g. /dashboard, /orders)
          // are SPA routes — serve index.html
          source: '**/!(*.*)',
          destination: '/index.html',
        },
      ],
      headers: [
        {
          // JS/CSS: moderate cache with must-revalidate so browsers
          // check for updates on each deploy. The immutable directive
          // has been REMOVED — it prevented browsers from ever fetching
          // updated CSS/JS after a redeploy, permanently breaking the
          // light theme (and any future CSS changes).
          source: '**/*.@(js|css)',
          headers: [
            {
              key: 'Cache-Control',
              value: 'max-age=3600, must-revalidate',
            },
          ],
        },
        {
          source: '**/*.@(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)',
          headers: [
            {
              key: 'Cache-Control',
              value: 'max-age=604800',
            },
          ],
        },
        {
          source: '**/*.@(html|json)',
          headers: [
            {
              key: 'Cache-Control',
              value: 'max-age=0, no-cache, must-revalidate',
            },
          ],
        },
      ],
      // i18n: true,  // uncomment if targeting Arabic localization
    },
  };

  // If client has a custom domain, add it to hosting config
  if (envData.CLIENT_DOMAIN) {
    // Note: firebase-tools doesn't auto-provision custom domains;
    // the domain must be verified in Firebase Console first.
    // We just note it for reference.
    config.hosting.site = envData.CLIENT_ID;
  }

  const configPath = path.join(workspaceDir, 'firebase.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  return configPath;
}

/**
 * Generate a .firebaserc file pointing to the client's Firebase project.
 *
 * @param {string} workspaceDir
 * @param {string} projectId
 * @returns {string} path to the generated .firebaserc
 */
function generateFirebaseRC(workspaceDir, projectId) {
  const rc = {
    projects: {
      default: projectId,
    },
  };

  const rcPath = path.join(workspaceDir, '.firebaserc');
  fs.writeFileSync(rcPath, JSON.stringify(rc, null, 2), 'utf-8');
  return rcPath;
}

/* ─────────────────────────────────────────────
 * BUILD PREPARATION
 * ───────────────────────────────────────────── */

/**
 * Prepare the deployment workspace for a client.
 *
 * Steps:
 *  1. Run injection.js to produce a build from source with env values
 *  2. Create a temp Firebase workspace directory
 *  3. Generate firebase.json + .firebaserc
 *  4. Copy injected build output into workspace/public/
 *
 * @param {string} clientId
 * @param {string} sourceDir   — ERP repo root (files with placeholders)
 * @param {Object} envData     — parsed .env object from vault
 * @returns {{
 *   success: boolean,
 *   workspaceDir?: string,
 *   buildDir?: string,
 *   injectionReport?: Object,
 *   error?: string
 * }}
 */
function prepareDeployment(clientId, sourceDir, envData) {
  // Step 1: Build workspace directory
  // Convention: cli/.build-cache/<clientId>-ws-<timestamp>
  const timestamp = Date.now();
  const workspaceDir = path.join(BUILD_CACHE_DIR, `${clientId}-ws-${timestamp}`);
  const buildDir = path.join(workspaceDir, 'public');

  // Step 2: Run injection
  const injectionReport = injection.injectConfig(sourceDir, buildDir, envData);

  if (!injectionReport.success) {
    return {
      success: false,
      workspaceDir,
      injectionReport,
      error: `Injection failed: ${injectionReport.errors.length} error(s). ` +
             `${injectionReport.unreplacedPlaceholders.length} unreplaced placeholder(s).`,
    };
  }

  // Step 3: Generate Firebase config files in the workspace root
  generateFirebaseConfig(workspaceDir, envData);
  generateFirebaseRC(workspaceDir, envData.FIREBASE_PROJECT_ID);

  return {
    success: true,
    workspaceDir,
    buildDir,
    injectionReport,
  };
}

/* ─────────────────────────────────────────────
 * DEPLOYMENT EXECUTION
 * ───────────────────────────────────────────── */

/**
 * Execute the Firebase Hosting deployment.
 *
 * Shells out to `npx firebase-tools deploy --only hosting`.
 * The workspace directory becomes the cwd for the command so firebase-tools
 * picks up the local firebase.json and .firebaserc.
 *
 * @param {string} workspaceDir — the temp Firebase workspace (has firebase.json + .firebaserc)
 * @param {string} projectId    — for logging and verification
 * @param {Object} options
 * @param {boolean} [options.dryRun]    — prepare but don't deploy
 * @param {boolean} [options.verbose]   — stream firebase-tools output live
 * @param {number} [options.timeoutMs]  — max wait time (default 5 min)
 * @returns {Promise<{
 *   success: boolean,
 *   hostingVersion?: string,
 *   output?: string,
 *   error?: string,
 *   durationMs?: number
 * }>}
 */
async function executeDeploy(workspaceDir, projectId, options = {}) {
  const { dryRun = false, verbose = false, timeoutMs = 300000 } = options;

  if (dryRun) {
    return {
      success: true,
      output: `[DRY-RUN] Would deploy workspace ${workspaceDir} to project ${projectId}`,
      durationMs: 0,
    };
  }

  const startTime = Date.now();

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    // Use spawn for live output streaming
    const child = spawn(
      'npx',
      ['-y', 'firebase-tools', 'deploy', '--only', 'hosting', '--project', projectId],
      {
        cwd: workspaceDir,
        stdio: verbose ? 'inherit' : 'pipe',
        timeout: timeoutMs,
        env: {
          ...process.env,
          // Suppress the firebase-tools update nag
          FIREBASE_DISABLE_UPDATE_CHECK: 'true',
        },
        // Windows: shell:true helps find npx
        shell: process.platform === 'win32',
      }
    );

    if (!verbose) {
      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    child.on('close', (code) => {
      const durationMs = Date.now() - startTime;
      const combinedOutput = stdout + stderr;

      if (code === 0) {
        // Parse the hosting release version from output
        // firebase-tools prints: "✔  Deploy complete! ... hosting:<channel> <version> ..."
        const hostingVersion = parseHostingVersion(combinedOutput);

        resolve({
          success: true,
          hostingVersion,
          output: combinedOutput,
          durationMs,
        });
      } else {
        resolve({
          success: false,
          error: `firebase-tools exited with code ${code}`,
          output: combinedOutput,
          durationMs,
        });
      }
    });

    child.on('error', (error) => {
      const durationMs = Date.now() - startTime;
      // ENOTFOUND usually means npx/firebase-tools not installed
      if (error.code === 'ENOENT') {
        resolve({
          success: false,
          error: 'firebase-tools not found. Install with: npm install -g firebase-tools',
          durationMs,
        });
      } else {
        resolve({
          success: false,
          error: `Failed to start firebase-tools: ${error.message}`,
          durationMs,
        });
      }
    });
  });
}

/**
 * Parse the hosting release version from firebase-tools deploy output.
 *
 * firebase-tools v13+ outputs lines like:
 *   "✔  Deploy complete!"
 *   "Project Console: https://console.firebase.google.com/project/<id>/overview"
 *   "Hosting URL: https://<project>.web.app"
 *
 * We capture the output timestamp + project ID as the version reference
 * since firebase-tools doesn't always print a numeric version.
 *
 * @param {string} output — combined stdout + stderr from firebase-tools
 * @returns {string|null} version identifier or null
 */
function parseHostingVersion(output) {
  // Try to find a hosting release version/ID
  const versionMatch = output.match(/hosting[:\s]+([^\s]+)/i);
  if (versionMatch) return versionMatch[1];

  // Fallback: look for "Deploy complete" confirmation
  if (output.includes('Deploy complete')) {
    return `deployed-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  }

  return null;
}

/* ─────────────────────────────────────────────
 * DEPLOY HISTORY RECORDING
 * ───────────────────────────────────────────── */

/**
 * Record a deployment in the client's deploy-history.json.
 *
 * Each entry:
 *   {
 *     timestamp: ISO 8601,
 *     deployTarget: "production" | "staging",
 *     hostingVersion: string|null,
 *     projectId: string,
 *     commitHash: string|null,
 *     backupFile: string|null,
 *     injectionStats: { filesProcessed, totalReplacements },
 *     durationMs: number,
 *     success: boolean,
 *     error: string|null
 *   }
 *
 * @param {string} clientId
 * @param {Object} entry — the deploy record
 */
function recordDeploy(clientId, entry) {
  const historyPath = vault.getDeployHistoryPath(clientId);
  const clientDir = vault.getClientDir(clientId);

  // Ensure client directory exists
  if (!fs.existsSync(clientDir)) {
    fs.mkdirSync(clientDir, { recursive: true });
  }

  // Read existing history
  let history = [];
  if (fs.existsSync(historyPath)) {
    try {
      history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
    } catch (_) {
      history = []; // corrupt file → start fresh
    }
  }

  // Get git commit hash if available
  let commitHash = null;
  try {
    commitHash = execSync('git rev-parse --short HEAD', {
      cwd: path.resolve(__dirname, '..', '..'),
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch (_) {
    // Not a git repo, or git not available — fine
  }

  const record = {
    timestamp: new Date().toISOString(),
    deployTarget: entry.deployTarget || 'production',
    hostingVersion: entry.hostingVersion || null,
    projectId: entry.projectId || null,
    commitHash: commitHash,
    backupFile: entry.backupFile || null,
    injectionStats: {
      filesProcessed: entry.injectionReport?.filesProcessed || 0,
      totalReplacements: entry.injectionReport?.totalReplacements || 0,
    },
    durationMs: entry.durationMs || 0,
    success: entry.success !== false,
    error: entry.error || null,
  };

  history.push(record);

  // Keep only the last 100 entries to prevent unbounded growth
  if (history.length > 100) {
    history = history.slice(-100);
  }

  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf-8');
  return record;
}

/* ─────────────────────────────────────────────
 * MAIN DEPLOYMENT FLOW (single client)
 * ───────────────────────────────────────────── */

/**
 * Full deployment pipeline for a single client.
 *
 * @param {string} clientId
 * @param {string} sourceDir   — ERP repo root
 * @param {Object} options
 * @param {boolean} [options.dryRun]
 * @param {boolean} [options.verbose]
 * @param {boolean} [options.skipBackup]
 * @param {string} [options.backupFile] — path to a pre-existing backup to record
 * @returns {Promise<Object>} deployment result
 */
async function deployClient(clientId, sourceDir, options = {}) {
  const { dryRun = false, verbose = false, skipBackup = false, backupFile = null } = options;

  const envData = vault.readEnvTransparent(clientId);
  const deployTarget = envData.DEPLOY_TARGET || 'production';

  if (!envData || !envData.FIREBASE_PROJECT_ID) {
    return {
      success: false,
      error: `No valid .env for client "${clientId}". Run create-client.js first.`,
    };
  }

  const startTime = Date.now();

  // Step 1: Prepare deployment (inject + generate configs)
  const prepResult = prepareDeployment(clientId, sourceDir, envData);

  if (!prepResult.success) {
    logger.logError(logger.ACTION_TYPES.DEPLOY_FAILED, clientId,
      new Error(prepResult.error));
    return prepResult;
  }

  // Step 2: Execute Firebase deploy
  const deployResult = await executeDeploy(
    prepResult.workspaceDir,
    envData.FIREBASE_PROJECT_ID,
    { dryRun, verbose }
  );

  const durationMs = Date.now() - startTime;

  // Step 3: Record in deploy history
  const record = recordDeploy(clientId, {
    deployTarget,
    hostingVersion: deployResult.hostingVersion,
    projectId: envData.FIREBASE_PROJECT_ID,
    backupFile,
    injectionReport: prepResult.injectionReport,
    durationMs,
    success: deployResult.success,
    error: deployResult.error,
  });

  // Step 4: Log
  if (deployResult.success) {
    logger.logAction(logger.ACTION_TYPES.DEPLOY_COMPLETED, clientId, durationMs, {
      deployTarget,
      hostingVersion: deployResult.hostingVersion,
      filesProcessed: prepResult.injectionReport.filesProcessed,
      totalReplacements: prepResult.injectionReport.totalReplacements,
    });
  } else {
    logger.logError(logger.ACTION_TYPES.DEPLOY_FAILED, clientId,
      new Error(deployResult.error), durationMs);
  }

  return {
    success: deployResult.success,
    clientId,
    deployTarget,
    hostingVersion: deployResult.hostingVersion,
    output: deployResult.output,
    error: deployResult.error,
    durationMs,
    workspaceDir: prepResult.workspaceDir,
    injectionReport: prepResult.injectionReport,
    record,
  };
}

/* ─────────────────────────────────────────────
 * BATCH DEPLOYMENT (--all)
 * ───────────────────────────────────────────── */

/**
 * Deploy multiple clients sequentially (--all mode).
 * Stops on first failure unless continueOnError is true.
 *
 * @param {string[]} clientIds
 * @param {string} sourceDir
 * @param {Object} options
 * @param {boolean} [options.continueOnError] — keep going despite failures
 * @returns {Promise<{
 *   success: boolean,
 *   results: Object[],
 *   successCount: number,
 *   failureCount: number,
 *   errors: string[]
 * }>}
 */
async function deployAllClients(clientIds, sourceDir, options = {}) {
  const { continueOnError = false } = options;
  const results = [];
  const errors = [];

  for (const clientId of clientIds) {
    const result = await deployClient(clientId, sourceDir, options);

    results.push(result);

    if (!result.success) {
      errors.push(`[${clientId}] ${result.error}`);
      logger.logError(logger.ACTION_TYPES.DEPLOY_FAILED, clientId,
        new Error(result.error));

      if (!continueOnError) {
        break; // stop on first failure
      }
    }
  }

  const successCount = results.filter(r => r.success).length;
  const failureCount = results.filter(r => !r.success).length;

  return {
    success: failureCount === 0,
    results,
    successCount,
    failureCount,
    errors,
  };
}

/* ─────────────────────────────────────────────
 * CLEANUP
 * ───────────────────────────────────────────── */

/**
 * Clean up old build cache directories.
 * Removes build dirs older than `maxAgeDays` to prevent disk bloat.
 *
 * @param {number} [maxAgeDays] — default 7 days
 * @returns {{ deleted: number, freedMB: number }}
 */
function cleanupBuildCache(maxAgeDays = 7) {
  if (!fs.existsSync(BUILD_CACHE_DIR)) {
    return { deleted: 0, freedMB: 0 };
  }

  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let freedBytes = 0;

  const entries = fs.readdirSync(BUILD_CACHE_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(BUILD_CACHE_DIR, entry.name);
    const stat = fs.statSync(entryPath);

    if (now - stat.mtimeMs > maxAgeMs) {
      // Calculate size before deleting
      freedBytes += getDirSize(entryPath);
      fs.rmSync(entryPath, { recursive: true, force: true });
      deleted++;
    }
  }

  return {
    deleted,
    freedMB: Math.round((freedBytes / (1024 * 1024)) * 100) / 100,
  };
}

/**
 * Recursively compute the total size of a directory in bytes.
 * @param {string} dirPath
 * @returns {number}
 */
function getDirSize(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;

  let total = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += getDirSize(entryPath);
    } else {
      try {
        total += fs.statSync(entryPath).size;
      } catch (_) {
        // skip files we can't stat
      }
    }
  }

  return total;
}

/* ─────────────────────────────────────────────
 * EXPORTS
 * ───────────────────────────────────────────── */

module.exports = {
  // Core deploy flow
  deployClient,
  deployAllClients,

  // Steps (exposed for fine-grained control)
  prepareDeployment,
  executeDeploy,
  recordDeploy,

  // Config generation
  generateFirebaseConfig,
  generateFirebaseRC,

  // Utilities
  cleanupBuildCache,
  parseHostingVersion,
  BUILD_CACHE_DIR,
};