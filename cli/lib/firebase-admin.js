/**
 * cli/lib/firebase-admin.js — Firebase Admin SDK Bootstrap
 * ==========================================================
 *
 * Thin, centralized wrapper around `firebase-admin`. Every CLI script that
 * needs to talk to Firestore/Auth goes through this module — never through
 * direct `firebase-admin` calls.
 *
 * Responsibilities:
 *   - Initialize (and cache) one Admin SDK app per client project
 *   - Load service account credentials from the vault convention
 *   - Return ready-to-use `admin.auth()` and `admin.firestore()` instances
 *   - Clean shutdown (`destroyApp`)
 *
 * App naming convention:
 *   Each initialized app gets the name `nazamly-<clientId>` so we can
 *   look it up later and avoid collisions. firebase-admin enforces unique
 *   app names per process.
 */

'use strict';

const fs = require('fs');
const vault = require('./vault.js');

/* ─────────────────────────────────────────────
 * APP REGISTRY
 * ───────────────────────────────────────────── */

/**
 * Map of clientId → initialized Firebase Admin app instance.
 * @type {Map<string, import('firebase-admin').app.App>}
 */
const appCache = new Map();

/* ─────────────────────────────────────────────
 * SERVICE ACCOUNT RESOLUTION
 * ───────────────────────────────────────────── */

/**
 * Get the canonical service account JSON key path for a client.
 * Convention: ../nazamly-clients-vault/<clientId>/service-account.json
 *
 * @param {string} clientId
 * @returns {string} absolute path
 */
function getServiceAccountPath(clientId) {
  const clientDir = vault.getClientDir(clientId);
  const path = require('path');
  return path.join(clientDir, 'service-account.json');
}

/**
 * Load and validate a service account JSON key.
 *
 * @param {string} clientId
 * @returns {{ success: boolean, data?: Object, error?: string }}
 */
function loadServiceAccount(clientId) {
  const keyPath = getServiceAccountPath(clientId);

  if (!fs.existsSync(keyPath)) {
    return {
      success: false,
      error: `Service account key not found at "${keyPath}".\n` +
             `Download it from Firebase Console → Project Settings → Service Accounts →\n` +
             `"Generate new private key", save it to the path above.`,
    };
  }

  let raw, parsed;
  try {
    raw = fs.readFileSync(keyPath, 'utf-8');
    parsed = JSON.parse(raw);
  } catch (e) {
    return { success: false, error: `Failed to read/parse service account key: ${e.message}` };
  }

  // Sanity checks
  if (parsed.type !== 'service_account') {
    return { success: false, error: `Key type "${parsed.type}" — expected "service_account".` };
  }
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    return { success: false, error: 'Key is missing required fields (project_id, client_email, private_key).' };
  }

  return { success: true, data: parsed };
}

/* ─────────────────────────────────────────────
 * INITIALIZE / GET APP
 * ───────────────────────────────────────────── */

/**
 * Initialize (or retrieve cached) Admin SDK app for a client.
 *
 * On first call: reads the client's .env + service account key, initializes
 * a new firebase-admin app named `nazamly-<clientId>`.
 * On subsequent calls: returns the cached instance.
 *
 * @param {string} clientId
 * @returns {Promise<{
 *   success: boolean,
 *   app?: import('firebase-admin').app.App,
 *   auth?: import('firebase-admin').auth.Auth,
 *   db?: import('firebase-admin').firestore.Firestore,
 *   projectId?: string,
 *   error?: string
 * }>}
 */
async function getAdminApp(clientId) {
  // Check cache first
  if (appCache.has(clientId)) {
    const app = appCache.get(clientId);
    return {
      success: true,
      app,
      auth: app.auth(),
      db: app.firestore(),
      projectId: app.options.projectId,
    };
  }

  // Load .env to get project ID
  const envData = vault.readEnvTransparent(clientId);
  const projectId = envData.FIREBASE_PROJECT_ID;

  if (!projectId) {
    return {
      success: false,
      error: `No FIREBASE_PROJECT_ID found for client "${clientId}". Run create-client.js first.`,
    };
  }

  // Load service account key
  const keyResult = loadServiceAccount(clientId);
  if (!keyResult.success) {
    return keyResult; // { success: false, error }
  }

  // Verify service account project matches .env project
  if (keyResult.data.project_id !== projectId) {
    return {
      success: false,
      error: `Service account project_id "${keyResult.data.project_id}" ` +
             `does not match FIREBASE_PROJECT_ID "${projectId}" in .env. ` +
             `Check that the service account key belongs to the correct Firebase project.`,
    };
  }

  // Dynamic require — firebase-admin is heavy
  let admin;
  try {
    admin = require('firebase-admin');
  } catch (e) {
    return {
      success: false,
      error: 'firebase-admin package is not installed. Run: npm install',
    };
  }

  // Initialize
  const appName = `nazamly-${clientId}`;

  try {
    const app = admin.initializeApp(
      {
        credential: admin.credential.cert(keyResult.data),
        projectId: projectId,
      },
      appName
    );

    appCache.set(clientId, app);

    return {
      success: true,
      app,
      auth: app.auth(),
      db: app.firestore(),
      projectId: projectId,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to initialize Firebase Admin SDK: ${error.message}`,
    };
  }
}

/* ─────────────────────────────────────────────
 * CLEANUP
 * ───────────────────────────────────────────── */

/**
 * Tear down the Admin SDK app for a client.
 * Call this when a script is done with a client to free resources.
 *
 * @param {string} clientId
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function destroyApp(clientId) {
  const app = appCache.get(clientId);
  if (!app) {
    return { success: true }; // nothing to destroy
  }

  try {
    await app.delete();
    appCache.delete(clientId);
    return { success: true };
  } catch (error) {
    return { success: false, error: `Failed to destroy app: ${error.message}` };
  }
}

/**
 * Tear down ALL cached Admin SDK apps.
 * Call at process exit for clean shutdown.
 *
 * @returns {Promise<{ success: boolean, errors: string[] }>}
 */
async function destroyAllApps() {
  const errors = [];
  const clientIds = Array.from(appCache.keys());

  for (const clientId of clientIds) {
    const result = await destroyApp(clientId);
    if (!result.success) {
      errors.push(`[${clientId}] ${result.error}`);
    }
  }

  return { success: errors.length === 0, errors };
}

/* ─────────────────────────────────────────────
 * HELPER: LIST ALL INITIALIZED CLIENTS
 * ───────────────────────────────────────────── */

/**
 * Get the list of client IDs that currently have an active Admin SDK app.
 * @returns {string[]}
 */
function getActiveApps() {
  return Array.from(appCache.keys());
}

/**
 * Check if an app is already initialized for a client.
 * @param {string} clientId
 * @returns {boolean}
 */
function isAppInitialized(clientId) {
  return appCache.has(clientId);
}

/* ─────────────────────────────────────────────
 * EXPORTS
 * ───────────────────────────────────────────── */

module.exports = {
  getAdminApp,
  destroyApp,
  destroyAllApps,
  getActiveApps,
  isAppInitialized,
  getServiceAccountPath,
  loadServiceAccount,
};