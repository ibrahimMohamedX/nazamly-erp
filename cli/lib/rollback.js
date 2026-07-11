/**
 * cli/lib/rollback.js — Rollback Engine
 * ======================================
 *
 * Enables one-command reversal of a deployment. Two strategies:
 *
 *   A. Firebase Hosting rollback (preferred):
 *      Uses `firebase hosting:clone` to revert to a previous release.
 *      Firebase Hosting keeps all deployed versions — rollback just
 *      switches which version the live channel serves.
 *      Requires: firebase-tools v13+
 *
 *   B. Re-deploy from prior build (fallback):
 *      If hosting:clone is unavailable, re-runs injection + deploy
 *      using the previous commit's source code. This requires a git
 *      checkout of the old commit, injection with the same env data,
 *      and a fresh deploy.
 *
 *   C. Data rollback (optional):
 *      Restores a backup JSON created before the problematic deploy.
 *      This is handled by restore.js — rollback.js can trigger it
 *      via the --also-restore flag.
 *
 * Flow:
 *   1. Read deploy-history.json for the client
 *   2. Identify the target version to roll back to (previous, or specified)
 *   3. Attempt hosting:clone first
 *   4. If clone fails, fall back to re-deploy from source
 *   5. If --also-restore, run restore.js on the backup associated with the target version
 *   6. Record the rollback in deploy-history.json and audit log
 *
 * Safety:
 *   - Requires --confirm (rollback is not a routine operation)
 *   - Dry-run mode shows what would happen without executing
 *   - Validates that a previous version exists before attempting
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const vault = require('./vault.js');
const logger = require('./logger.js');

/* ─────────────────────────────────────────────
 * DEPLOY HISTORY READING
 * ───────────────────────────────────────────── */

/**
 * Read a client's deploy history, sorted newest first.
 *
 * @param {string} clientId
 * @returns {{ success: boolean, history?: Array, error?: string }}
 */
function readDeployHistory(clientId) {
  const historyPath = vault.getDeployHistoryPath(clientId);

  if (!fs.existsSync(historyPath)) {
    return { success: false, error: `No deploy history for "${clientId}". Nothing to roll back.` };
  }

  try {
    const raw = fs.readFileSync(historyPath, 'utf-8');
    const history = JSON.parse(raw);

    if (!Array.isArray(history) || history.length === 0) {
      return { success: false, error: `Deploy history for "${clientId}" is empty or corrupted.` };
    }

    // Newest first
    history.reverse();

    return { success: true, history };
  } catch (e) {
    return { success: false, error: `Failed to read deploy history: ${e.message}` };
  }
}

/**
 * Find a specific deploy entry by index or version string.
 *
 * @param {string} clientId
 * @param {number|string} [target] — 0 = most recent, 1 = previous (default), "v123" = by version
 * @returns {{ success: boolean, entry?: Object, index?: number, error?: string }}
 */
function findTargetEntry(clientId, target = 1) {
  const result = readDeployHistory(clientId);
  if (!result.success) {
    return result;
  }

  const { history } = result;

  let entry;
  if (typeof target === 'string') {
    // Search by hosting version string
    const idx = history.findIndex(e => e.hostingVersion === target);
    if (idx === -1) {
      return { success: false, error: `Version "${target}" not found in deploy history.` };
    }
    entry = history[idx];
  } else {
    // By index (0 = latest, 1 = previous, 2 = two ago)
    if (target >= history.length) {
      return {
        success: false,
        error: `Requested rollback to entry #${target}, but only ${history.length} entries exist. ` +
               `Use --list to see available versions.`,
      };
    }
    entry = history[target];
  }

  // Must be a successful deploy to roll back to
  if (!entry.success) {
    return {
      success: false,
      error: `Entry #${target} was a FAILED deployment — cannot roll back to a failure. ` +
             `Choose an earlier successful entry.`,
    };
  }

  return { success: true, entry, index: typeof target === 'number' ? target : history.indexOf(entry) };
}

/* ─────────────────────────────────────────────
 * STRATEGY A: HOSTING:CLONE
 * ───────────────────────────────────────────── */

/**
 * Attempt to roll back Firebase Hosting to a previous release using
 * `firebase hosting:clone`.
 *
 * firebase-tools syntax (v13+):
 *   firebase hosting:clone <sourceSite>:<sourceChannel> <targetChannel>
 *
 * For the default live channel:
 *   firebase hosting:clone <project>:live <version> live
 *
 * This effectively reverts the live channel to serve the specified version.
 *
 * @param {string} projectId
 * @param {string} hostingVersion
 * @param {number} [timeoutMs] — default 2 min
 * @returns {Promise<{ success: boolean, output?: string, error?: string, durationMs?: number }>}
 */
async function rollbackHosting(projectId, hostingVersion, timeoutMs = 120000) {
  const startTime = Date.now();

  return new Promise((resolve) => {
    // Strategy A: Try hosting:clone
    const args = [
      '-y', 'firebase-tools',
      'hosting:clone',
      `${projectId}:${hostingVersion}`,
      `${projectId}:live`,
      '--project', projectId,
    ];

    const child = spawn('npx', args, {
      stdio: 'pipe',
      timeout: timeoutMs,
      env: {
        ...process.env,
        FIREBASE_DISABLE_UPDATE_CHECK: 'true',
      },
      shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      const durationMs = Date.now() - startTime;
      const combined = stdout + stderr;

      if (code === 0) {
        resolve({
          success: true,
          output: combined,
          method: 'hosting:clone',
          durationMs,
        });
      } else {
        // hosting:clone failed — caller should try strategy B
        resolve({
          success: false,
          error: `hosting:clone failed (exit ${code}).`,
          output: combined,
          method: 'hosting:clone',
          durationMs,
        });
      }
    });

    child.on('error', (err) => {
      resolve({
        success: false,
        error: `Failed to start firebase-tools: ${err.message}`,
        method: 'hosting:clone',
        durationMs: Date.now() - startTime,
      });
    });
  });
}

/* ─────────────────────────────────────────────
 * STRATEGY B: RE-DEPLOY FROM PRIOR SOURCE
 * ───────────────────────────────────────────── */

/**
 * Roll back by re-deploying the previous commit's code.
 *
 * This requires:
 *   - Git is available
 *   - The commit hash is recorded in deploy history
 *   - The current .env values are still valid (Firebase keys didn't change)
 *
 * Flow:
 *   1. Stash any uncommitted changes
 *   2. Checkout the target commit
 *   3. Run injection + deploy (using deployer.js)
 *   4. Return to original branch/commit
 *   5. Un-stash changes
 *
 * This is a HIGH-RISK operation and requires --confirm.
 *
 * @param {string} clientId
 * @param {Object} targetEntry  — the deploy history entry to revert to
 * @param {Object} options
 * @returns {Promise<{ success: boolean, output?: string, error?: string, method?: string, durationMs?: number }>}
 */
async function rollbackByRedeploy(clientId, targetEntry, options = {}) {
  const startTime = Date.now();
  const commitHash = targetEntry.commitHash;

  if (!commitHash) {
    return {
      success: false,
      error: 'Target deploy entry has no commit hash — cannot re-deploy from source.',
      durationMs: Date.now() - startTime,
    };
  }

  // Verify the commit still exists
  try {
    execSync(`git cat-file -t ${commitHash}`, {
      cwd: path.resolve(__dirname, '..', '..'),
      encoding: 'utf-8',
      timeout: 10000,
      stdio: 'pipe',
    });
  } catch (_) {
    return {
      success: false,
      error: `Commit ${commitHash} no longer exists in this repository. ` +
             `It may have been garbage-collected or this is a shallow clone.`,
      durationMs: Date.now() - startTime,
    };
  }

  // This is a safety-guarded operation — the CLI wrapper ensures --confirm
  // and dry-run preview before we reach this point.
  const repoRoot = path.resolve(__dirname, '..', '..');

  try {
    // Get current branch/commit to return to later
    const originalRef = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    // Check for uncommitted changes
    const statusOutput = execSync('git status --porcelain', {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    const hasChanges = statusOutput.length > 0;

    if (hasChanges) {
      execSync('git stash push --include-untracked -m "nazamly-rollback-auto-stash"', {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 30000,
      });
    }

    // Checkout the target commit
    execSync(`git checkout ${commitHash}`, {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 30000,
      stdio: 'pipe',
    });

    // Re-run deployment with current .env
    const deployer = require('./deployer.js');
    const deployResult = await deployer.deployClient(clientId, repoRoot, {
      dryRun: options.dryRun || false,
      verbose: options.verbose || false,
      skipBackup: true, // backup was already taken before the bad deploy
    });

    // Return to original branch
    execSync(`git checkout ${originalRef}`, {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 30000,
      stdio: 'pipe',
    });

    // Restore stashed changes
    if (hasChanges) {
      try {
        execSync('git stash pop', {
          cwd: repoRoot,
          encoding: 'utf-8',
          timeout: 30000,
          stdio: 'pipe',
        });
      } catch (_) {
        // Stash pop may conflict — that's ok, changes are preserved in the stash
      }
    }

    const durationMs = Date.now() - startTime;

    return {
      success: deployResult.success,
      output: deployResult.output,
      error: deployResult.error,
      method: 're-deploy',
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;

    // Try to recover: return to original branch
    try {
      execSync('git checkout -', { cwd: repoRoot, encoding: 'utf-8', timeout: 15000, stdio: 'pipe' });
    } catch (_) {
      // Catastrophic — repo may be in a bad state. Log it.
    }

    return {
      success: false,
      error: `Re-deploy rollback failed: ${error.message}`,
      method: 're-deploy',
      durationMs,
    };
  }
}

/* ─────────────────────────────────────────────
 * LIST AVAILABLE ROLLBACK TARGETS
 * ───────────────────────────────────────────── */

/**
 * Generate a human-readable list of deploy history entries
 * showing which versions are available for rollback.
 *
 * @param {string} clientId
 * @returns {{ success: boolean, entries?: Array, error?: string }}
 */
function listRollbackTargets(clientId) {
  const result = readDeployHistory(clientId);
  if (!result.success) {
    return result;
  }

  const entries = result.history.map((e, i) => ({
    index: i,
    timestamp: e.timestamp,
    version: e.hostingVersion || 'unknown',
    success: e.success,
    commitHash: e.commitHash || 'unknown',
    rollbackEligible: e.success, // only successful deploys can be rolled back to
  }));

  return { success: true, entries };
}

/* ─────────────────────────────────────────────
 * MAIN ROLLBACK ORCHESTRATOR
 * ───────────────────────────────────────────── */

/**
 * Execute a full rollback for a client.
 *
 * @param {string} clientId
 * @param {Object} options
 * @param {number|string} [options.target]    — deploy history index or version string (default: 1 = previous)
 * @param {boolean} [options.dryRun]          — preview only
 * @param {boolean} [options.alsoRestore]     — also restore Firestore from backup
 * @param {boolean} [options.verbose]
 * @returns {Promise<Object>} rollback result
 */
async function executeRollback(clientId, options = {}) {
  const { target = 1, dryRun = false, alsoRestore = false, verbose = false } = options;
  const startTime = Date.now();

  // Step 1: Find the target entry
  const targetResult = findTargetEntry(clientId, target);
  if (!targetResult.success) {
    return {
      success: false,
      error: targetResult.error,
      durationMs: Date.now() - startTime,
    };
  }

  const { entry } = targetResult;

  // Step 2: Dry-run preview
  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      targetEntry: entry,
      summary: formatRollbackPreview(clientId, entry, alsoRestore),
      durationMs: Date.now() - startTime,
    };
  }

  // Step 3: Attempt rollback (strategy A: hosting:clone)
  const envData = vault.readEnvTransparent(clientId);
  const projectId = envData.FIREBASE_PROJECT_ID;

  let rollbackResult;

  if (entry.hostingVersion && entry.hostingVersion.startsWith('deployed-')) {
    // Timestamp-based version — hosting:clone won't work with these
    // Skip straight to strategy B
    rollbackResult = { success: false, error: 'Timestamp version, skipping hosting:clone' };
  } else if (entry.hostingVersion) {
    // Try hosting:clone
    rollbackResult = await rollbackHosting(projectId, entry.hostingVersion);
  } else {
    // No version recorded — must use strategy B
    rollbackResult = { success: false, error: 'No hosting version recorded, skipping hosting:clone' };
  }

  // Step 4: Fallback to strategy B if clone failed
  if (!rollbackResult.success) {
    rollbackResult = await rollbackByRedeploy(clientId, entry, {
      dryRun,
      verbose,
    });
  }

  const durationMs = Date.now() - startTime;

  // Step 5: Optional Firestore restore
  let restoreResult = null;
  if (alsoRestore && rollbackResult.success && entry.backupFile) {
    const restore = require('./restore.js');
    restoreResult = await restore.importFirestore(clientId, entry.backupFile, {
      dryRun: false,
    });
  }

  // Step 6: Record rollback in deploy history
  recordRollback(clientId, {
    rolledBackFrom: entry,
    rollbackMethod: rollbackResult.method,
    hostingVersion: entry.hostingVersion,
    projectId,
    alsoRestored: !!restoreResult?.success,
    backupFile: entry.backupFile,
    durationMs,
    success: rollbackResult.success,
    error: rollbackResult.error,
  });

  // Step 7: Log
  if (rollbackResult.success) {
    logger.logAction(logger.ACTION_TYPES.DEPLOY_ROLLED_BACK, clientId, durationMs, {
      rollbackMethod: rollbackResult.method,
      targetVersion: entry.hostingVersion,
      targetCommit: entry.commitHash,
      alsoRestored: !!restoreResult?.success,
    });
  } else {
    logger.logError(logger.ACTION_TYPES.DEPLOY_ROLLED_BACK, clientId,
      new Error(rollbackResult.error), durationMs);
  }

  return {
    success: rollbackResult.success,
    clientId,
    rollbackMethod: rollbackResult.method,
    hostingVersion: entry.hostingVersion,
    output: rollbackResult.output,
    error: rollbackResult.error,
    restoreResult,
    durationMs,
  };
}

/* ─────────────────────────────────────────────
 * RECORDING
 * ───────────────────────────────────────────── */

/**
 * Record a rollback in the deploy history.
 *
 * @param {string} clientId
 * @param {Object} rollbackDetails
 */
function recordRollback(clientId, rollbackDetails) {
  const historyPath = vault.getDeployHistoryPath(clientId);

  let history = [];
  if (fs.existsSync(historyPath)) {
    try {
      history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
    } catch (_) {
      history = [];
    }
  }

  const record = {
    timestamp: new Date().toISOString(),
    type: 'rollback',
    rollbackMethod: rollbackDetails.rollbackMethod,
    rolledBackFrom: {
      timestamp: rollbackDetails.rolledBackFrom?.timestamp,
      hostingVersion: rollbackDetails.rolledBackFrom?.hostingVersion,
      commitHash: rollbackDetails.rolledBackFrom?.commitHash,
    },
    hostingVersion: rollbackDetails.hostingVersion,
    projectId: rollbackDetails.projectId,
    alsoRestored: rollbackDetails.alsoRestored || false,
    backupFile: rollbackDetails.backupFile || null,
    durationMs: rollbackDetails.durationMs || 0,
    success: rollbackDetails.success !== false,
    error: rollbackDetails.error || null,
  };

  history.push(record);

  if (history.length > 100) {
    history = history.slice(-100);
  }

  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf-8');
}

/* ─────────────────────────────────────────────
 * FORMATTING
 * ───────────────────────────────────────────── */

function formatRollbackPreview(clientId, targetEntry, alsoRestore) {
  return [
    `Client:         ${clientId}`,
    `Target version: ${targetEntry.hostingVersion || 'unknown'}`,
    `Target commit:  ${targetEntry.commitHash || 'unknown'}`,
    `Deployed at:    ${targetEntry.timestamp}`,
    `Rollback method:  hosting:clone (attempted first), re-deploy (fallback)`,
    `Also restore:   ${alsoRestore ? 'YES — Firestore data will be restored from backup' : 'No'}`,
    `Backup file:    ${targetEntry.backupFile || 'none recorded'}`,
  ].join('\n  ');
}

/* ─────────────────────────────────────────────
 * EXPORTS
 * ───────────────────────────────────────────── */

module.exports = {
  executeRollback,
  rollbackHosting,
  rollbackByRedeploy,
  readDeployHistory,
  findTargetEntry,
  listRollbackTargets,
  recordRollback,
};