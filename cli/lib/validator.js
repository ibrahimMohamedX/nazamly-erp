/**
 * cli/lib/validator.js — .env Validation & Firebase Connectivity Test
 * ===================================================================
 * Deep structural validation of client .env data — goes beyond the basic
 * presence/format checks in vault.js to provide Firebase-specific key format
 * verification, cross-field consistency checks, and a live Admin SDK
 * connectivity test against the target Firebase project.
 *
 * Vault.js already handles:
 *   - Required-field presence checks
 *   - Client ID format validation
 *   - Subscription months range check
 *   - Deploy target enum check
 *   - Basic API key / App ID format check
 *
 * This module ADDS:
 *   - Firebase key regex patterns (auth domain, storage bucket, sender ID)
 *   - Cross-field consistency (auth domain contains project ID, etc.)
 *   - Firebase Admin SDK connectivity test (lightweight Firestore ping)
 *   - Unified `validateAll()` that runs everything and returns a report object
 */

'use strict';

const vault = require('./vault.js');

/* ─────────────────────────────────────────────
 * FIREBASE KEY FORMAT PATTERNS
 * ───────────────────────────────────────────── */

/**
 * Regex patterns for each Firebase config key.
 * These are FORMAT checks — does the value look like the thing it claims to be?
 * They do NOT verify the key actually works (that's testFirebaseConnection's job).
 */
const KEY_PATTERNS = {
  FIREBASE_API_KEY: {
    pattern: /^AIza[A-Za-z0-9_-]{35}$/,
    description: 'Firebase Web API key — must start with "AIza" followed by exactly 35 alphanumeric, underscore, or hyphen characters',
    example: 'AIzaSyCfqb7u3Es7rq3kTg3K-qGmF2xYs-ZdM00',
  },
  FIREBASE_AUTH_DOMAIN: {
    // Typically: <project-id>.firebaseapp.com or a custom domain
    pattern: /^(?:[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?\.firebaseapp\.com|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,})$/,
    description: 'Firebase Auth domain — must be either <project>.firebaseapp.com or a valid custom domain (e.g., app.client.com)',
    example: 'erp-website-38fe1.firebaseapp.com',
  },
  FIREBASE_PROJECT_ID: {
    // Firebase project IDs: lowercase alphanumeric + hyphens, 6-30 chars
    pattern: /^[a-z][a-z0-9-]{4,29}[a-z0-9]$/,
    description: 'Firebase Project ID — lowercase letters, digits, hyphens; 6-30 chars; must start with a letter and end with alphanumeric',
    example: 'elnour-erp-abc12',
  },
  FIREBASE_STORAGE_BUCKET: {
    // Typically: <project-id>.appspot.com (can also be <project-id>.firebasestorage.app)
    pattern: /^(?:[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?\.appspot\.com|[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?\.firebasestorage\.app)$/,
    description: 'Firebase Storage bucket — typically <project>.appspot.com or <project>.firebasestorage.app',
    example: 'elnour-erp.appspot.com',
  },
  FIREBASE_MSG_SENDER_ID: {
    pattern: /^\d{10,12}$/,
    description: 'Firebase Cloud Messaging Sender ID — a 10-12 digit numeric string (project number)',
    example: '123456789012',
  },
  FIREBASE_APP_ID: {
    pattern: /^1:\d{8,12}:web:[a-f0-9]{20,32}$/i,
    description: 'Firebase Web App ID — format: 1:<project_number>:web:<hash>',
    example: '1:123456789012:web:abc123def4567890abcdef',
  },
};

/* ─────────────────────────────────────────────
 * DETAILED FIREBASE KEY VALIDATION
 * ───────────────────────────────────────────── */

/**
 * Validate each Firebase key against its expected format pattern.
 * Returns an array of error messages (empty = all keys look valid).
 *
 * @param {Object} envData — parsed .env object
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateFirebaseKeys(envData) {
  const errors = [];
  const warnings = [];

  for (const [key, { pattern, description }] of Object.entries(KEY_PATTERNS)) {
    const value = envData[key];

    // Skip if not present (presence check is vault.validateEnvData's job)
    if (value === undefined || value === null || String(value).trim() === '') {
      continue;
    }

    const trimmed = String(value).trim();

    if (!pattern.test(trimmed)) {
      errors.push(
        `${key}: "${trimmed}" does not match expected format. ${description}. Example: ${KEY_PATTERNS[key].example}`
      );
    }
  }

  return { errors, warnings };
}

/* ─────────────────────────────────────────────
 * CROSS-FIELD CONSISTENCY CHECKS
 * ───────────────────────────────────────────── */

/**
 * Check that fields that should correlate actually do.
 * E.g., auth domain should contain the project ID, storage bucket should
 * start with the project ID, app ID should contain the sender ID (project number).
 *
 * These are SOFT checks — they generate warnings, not errors, because
 * there are legitimate exceptions (custom domains, etc.).
 *
 * @param {Object} envData
 * @returns {string[]} warning messages
 */
function validateCrossFieldConsistency(envData) {
  const warnings = [];

  const projectId = String(envData.FIREBASE_PROJECT_ID || '').trim();
  const authDomain = String(envData.FIREBASE_AUTH_DOMAIN || '').trim();
  const storageBucket = String(envData.FIREBASE_STORAGE_BUCKET || '').trim();
  const senderId = String(envData.FIREBASE_MSG_SENDER_ID || '').trim();
  const appId = String(envData.FIREBASE_APP_ID || '').trim();

  if (!projectId) return warnings; // can't cross-check without project ID

  // Auth domain should contain the project ID (unless it's a custom domain)
  if (authDomain && !authDomain.startsWith(projectId) && authDomain.endsWith('.firebaseapp.com')) {
    warnings.push(
      `FIREBASE_AUTH_DOMAIN "${authDomain}" does not start with project ID "${projectId}". ` +
      `If this is a custom domain, this warning can be ignored.`
    );
  }

  // Storage bucket should start with the project ID
  if (storageBucket && !storageBucket.startsWith(projectId) && storageBucket.endsWith('.appspot.com')) {
    warnings.push(
      `FIREBASE_STORAGE_BUCKET "${storageBucket}" does not start with project ID "${projectId}". ` +
      `Default Firebase buckets always match the project ID.`
    );
  }

  // App ID's numeric part (the project number) should match the sender ID
  if (appId && senderId) {
    const appIdMatch = appId.match(/^1:(\d+):web:/i);
    if (appIdMatch && appIdMatch[1] !== senderId) {
      warnings.push(
        `FIREBASE_APP_ID project number "${appIdMatch[1]}" does not match ` +
        `FIREBASE_MSG_SENDER_ID "${senderId}". These are typically the same Firebase project number.`
      );
    }
  }

  // Auth domain and storage bucket project IDs should match
  if (authDomain && storageBucket) {
    const authProject = authDomain.replace('.firebaseapp.com', '');
    const bucketProject = storageBucket.replace('.appspot.com', '').replace('.firebasestorage.app', '');
    if (authProject !== bucketProject &&
        authDomain.endsWith('.firebaseapp.com') &&
        (storageBucket.endsWith('.appspot.com') || storageBucket.endsWith('.firebasestorage.app'))) {
      warnings.push(
        `Auth domain project "${authProject}" does not match storage bucket project "${bucketProject}". ` +
        `Both should refer to the same Firebase project.`
      );
    }
  }

  return warnings;
}

/* ─────────────────────────────────────────────
 * FIREBASE CONNECTIVITY TEST (Admin SDK)
 * ───────────────────────────────────────────── */

/**
 * Test connectivity to a Firebase project using the Admin SDK.
 *
 * Initializes a temporary Admin SDK app from the client's .env values,
 * attempts a lightweight Firestore read (the /system/config document),
 * then tears down the app. Measures latency.
 *
 * NOTE: This requires a service account JSON key file. The Admin SDK
 * authenticates via GOOGLE_APPLICATION_CREDENTIALS or by constructing
 * a credential from a service account key. Since each client project
 * would need its own service account key, this function accepts an
 * optional `serviceAccountPath` parameter.
 *
 * For practical use in the CLI workflow:
 *   - The user must have downloaded a service account JSON key from
 *     the Firebase console for each client project
 *   - The key can be stored in the vault as:
 *     ../nazamly-clients-vault/<clientId>/service-account.json
 *   - vault.js's getServiceAccountPath() provides the canonical path
 *
 * @param {Object} envData     — parsed .env object
 * @param {string} [serviceAccountPath] — path to service account JSON key file
 *   If omitted, defaults to ../nazamly-clients-vault/<clientId>/service-account.json
 *
 * @returns {Promise<{ success: boolean, error?: string, latencyMs?: number, projectId?: string }>}
 */
async function testFirebaseConnection(envData, serviceAccountPath) {
  const clientId = envData.CLIENT_ID;
  const projectId = envData.FIREBASE_PROJECT_ID;

  if (!clientId || !projectId) {
    return {
      success: false,
      error: 'CLIENT_ID and FIREBASE_PROJECT_ID are required for connectivity test',
    };
  }

  // Resolve the service account key path
  const keyPath = serviceAccountPath || getDefaultServiceAccountPath(clientId);

  const fs = require('fs');
  const path = require('path');

  if (!fs.existsSync(keyPath)) {
    return {
      success: false,
      error: `Service account key not found at "${keyPath}". ` +
             `Download it from Firebase Console → Project Settings → Service Accounts → Generate new private key. ` +
             `Place it in the vault at: ../nazamly-clients-vault/${clientId}/service-account.json`,
    };
  }

  let admin;
  try {
    // Dynamic require — firebase-admin is heavy, only load when needed
    admin = require('firebase-admin');
  } catch (e) {
    return {
      success: false,
      error: 'firebase-admin package is not installed. Run: npm install',
    };
  }

  // Build a unique app name to avoid collisions with other initialized apps
  const appName = `validator-test-${clientId}-${Date.now()}`;

  let app;
  const startTime = Date.now();

  try {
    // Load the service account key
    const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));

    // Verify the service account's project_id matches the .env project ID
    if (serviceAccount.project_id !== projectId) {
      return {
        success: false,
        error: `Service account project_id "${serviceAccount.project_id}" does not match ` +
               `FIREBASE_PROJECT_ID "${projectId}" in .env. Wrong service account key?`,
      };
    }

    // Initialize a temporary Admin SDK app
    app = admin.initializeApp(
      {
        credential: admin.credential.cert(serviceAccount),
        projectId: projectId,
      },
      appName
    );

    // Attempt a lightweight Firestore read — get the /system/config document
    // This verifies: (a) credentials work, (b) Firestore API is enabled,
    // (c) the project is reachable
    const db = admin.firestore(app);
    const docRef = db.collection('system').doc('config');

    const snapshot = await Promise.race([
      docRef.get(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Firestore read timed out after 15 seconds')), 15000)
      ),
    ]);

    const latencyMs = Date.now() - startTime;

    // Check what we got back
    if (snapshot.exists) {
      return {
        success: true,
        latencyMs,
        projectId: projectId,
        dataExists: true,
        summary: `Connected successfully in ${latencyMs}ms. /system/config document exists.`,
      };
    } else {
      // Connection works but the document doesn't exist yet (fresh project)
      return {
        success: true,
        latencyMs,
        projectId: projectId,
        dataExists: false,
        summary: `Connected successfully in ${latencyMs}ms. /system/config document does not exist yet (expected for a new project). Run the seeder to populate it.`,
      };
    }
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    return {
      success: false,
      latencyMs,
      error: `Firebase connection failed: ${error.message || error}`,
      hint: deduceFailureHint(error),
    };
  } finally {
    // ALWAYS clean up the temporary app
    if (app) {
      try {
        await app.delete();
      } catch (_) {
        // Best-effort cleanup — if it fails, the app name is unique so
        // it won't collide with future tests
      }
    }
  }
}

/**
 * Deduce a human-readable hint from a Firebase Admin SDK error.
 * Maps common error patterns to actionable suggestions.
 *
 * @param {Error} error
 * @returns {string}
 */
function deduceFailureHint(error) {
  const msg = String(error.message || error).toLowerCase();

  if (msg.includes('permission_denied') || msg.includes('not authorized') || msg.includes('forbidden')) {
    return 'The service account does not have permission to access Firestore. Check IAM roles in Google Cloud Console — it needs "Cloud Datastore User" or "Cloud Datastore Owner" role.';
  }
  if (msg.includes('not found') || msg.includes('project does not exist')) {
    return 'The Firebase project was not found. Verify FIREBASE_PROJECT_ID is correct and the project exists in the Firebase Console.';
  }
  if (msg.includes('invalid') && msg.includes('credential')) {
    return 'The service account key appears to be invalid or corrupted. Try downloading a fresh key from Firebase Console.';
  }
  if (msg.includes('network') || msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('etimedout')) {
    return 'Network connectivity issue. Check internet connection, firewall rules, and DNS resolution.';
  }
  if (msg.includes('quota') || msg.includes('exceeded') || msg.includes('resource_exhausted')) {
    return 'Firebase quota exceeded. The project may have hit its free-tier limits. Check usage in Firebase Console.';
  }
  if (msg.includes('unauthenticated') || msg.includes('auth') || msg.includes('jwt')) {
    return 'Authentication failed. The service account key may be expired or revoked. Generate a new one.';
  }

  return 'Check the Firebase Console for service status, verify the project ID, and ensure Firestore is enabled for this project.';
}

/**
 * Get the default service account JSON key path for a client.
 * Convention: stored in the vault alongside the .env file.
 *
 * @param {string} clientId
 * @returns {string} absolute path
 */
function getDefaultServiceAccountPath(clientId) {
  return vault.getClientDir(clientId) + '\\service-account.json';
}

/* ─────────────────────────────────────────────
 * UNIFIED VALIDATION — THE MAIN EXPORT
 * ───────────────────────────────────────────── */

/**
 * Run ALL validation checks against a parsed .env object.
 *
 * This is the primary entry point for scripts. It runs:
 *   1. vault.validateEnvData()       — presence + basic format checks
 *   2. validateFirebaseKeys()        — deep Firebase key regex validation
 *   3. validateCrossFieldConsistency() — cross-field correlation warnings
 *
 * Returns a structured report that callers can render however they want
 * (inquirer prompts, chalk-colored console output, etc.).
 *
 * Does NOT run connectivity test by default (it requires a service account
 * key and takes time). Callers should run testFirebaseConnection() separately
 * after the validation report comes back clean.
 *
 * @param {Object} envData — parsed .env object
 * @returns {{
 *   valid: boolean,
 *   errors: string[],
 *   warnings: string[],
 *   errorCount: number,
 *   warningCount: number
 * }}
 */
function validateEnv(envData) {
  // Step 1: Basic presence + format checks from vault.js
  const basicErrors = vault.validateEnvData(envData);

  // Step 2: Deep Firebase key pattern validation
  const { errors: keyErrors, warnings: keyWarnings } = validateFirebaseKeys(envData);

  // Step 3: Cross-field consistency
  const crossWarnings = validateCrossFieldConsistency(envData);

  // Merge
  const allErrors = [...basicErrors, ...keyErrors];
  const allWarnings = [...keyWarnings, ...crossWarnings];

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
    errorCount: allErrors.length,
    warningCount: allWarnings.length,
  };
}

/**
 * Check only whether an env object passes validation (no details).
 * Convenience wrapper for guard clauses.
 *
 * @param {Object} envData
 * @returns {boolean}
 */
function isValid(envData) {
  return validateEnv(envData).valid;
}

/* ─────────────────────────────────────────────
 * CLIENT ID VALIDATION (re-exported from vault)
 * ───────────────────────────────────────────── */

/**
 * Validate and normalize a client ID string.
 * Delegates to vault.sanitizeClientId().
 *
 * @param {string} rawId
 * @returns {{ valid: boolean, normalized?: string, error?: string }}
 */
function validateClientId(rawId) {
  try {
    const normalized = vault.sanitizeClientId(rawId);
    return { valid: true, normalized };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

/* ─────────────────────────────────────────────
 * SERVICE ACCOUNT KEY VALIDATION
 * ───────────────────────────────────────────── */

/**
 * Validate a service account JSON key file.
 *
 * Checks:
 *   - File exists and is readable
 *   - Is valid JSON
 *   - Has required fields (type, project_id, private_key, client_email)
 *   - type === 'service_account'
 *
 * @param {string} filePath — absolute path to the JSON key file
 * @returns {{ valid: boolean, projectId?: string, clientEmail?: string, error?: string }}
 */
function validateServiceAccountKey(filePath) {
  const fs = require('fs');

  if (!fs.existsSync(filePath)) {
    return { valid: false, error: `Service account key file not found: ${filePath}` };
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    return { valid: false, error: `Cannot read service account key file: ${e.message}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { valid: false, error: `Service account key file is not valid JSON: ${e.message}` };
  }

  // Check required fields
  const requiredFields = ['type', 'project_id', 'private_key', 'client_email'];
  const missing = requiredFields.filter(f => !parsed[f]);
  if (missing.length > 0) {
    return {
      valid: false,
      error: `Service account key is missing required fields: ${missing.join(', ')}. ` +
             `This does not look like a valid Firebase service account key.`,
    };
  }

  if (parsed.type !== 'service_account') {
    return {
      valid: false,
      error: `Key type is "${parsed.type}" — expected "service_account". This is not a Firebase service account key.`,
    };
  }

  return {
    valid: true,
    projectId: parsed.project_id,
    clientEmail: parsed.client_email,
  };
}

/**
 * Check whether a service account key exists for a client at the
 * default vault location.
 *
 * @param {string} clientId
 * @returns {boolean}
 */
function hasServiceAccountKey(clientId) {
  const fs = require('fs');
  return fs.existsSync(getDefaultServiceAccountPath(clientId));
}

/* ─────────────────────────────────────────────
 * EXPORTS
 * ───────────────────────────────────────────── */

module.exports = {
  // Primary entry point
  validateEnv,
  isValid,

  // Individual validation layers
  validateFirebaseKeys,
  validateCrossFieldConsistency,

  // Connectivity test
  testFirebaseConnection,

  // Client ID
  validateClientId,

  // Service account key
  validateServiceAccountKey,
  hasServiceAccountKey,
  getDefaultServiceAccountPath,

  // Constants
  KEY_PATTERNS,
};