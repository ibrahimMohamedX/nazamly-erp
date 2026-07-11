/**
 * cli/lib/seeder.js — Database Seeding Engine
 * ============================================
 *
 * Populates a NEW client's Firebase project with the initial data it needs
 * to function. This runs once, immediately after create-client.js has written
 * the .env file to the vault. It uses the Firebase Admin SDK (via
 * firebase-admin.js) to bypass client-side security rules and write directly.
 *
 * Seeding sequence (executed by seedAll):
 *   1. seedSuperAdmin  — locked owner account (from cli/seeder-config.json)
 *   2. seedClientAdmin  — tenant admin (from .env: ADMIN_EMAIL, ADMIN_PASSWORD)
 *   3. seedSystemConfig — /system/config doc (brandName, allowedEmails, settings)
 *   4. seedSubscription — /system_status/config (isActive, dates, usage caps)
 *
 * Each function is idempotent: if the account/document already exists, it
 * updates it rather than failing. This makes re-seeding safe.
 *
 * Super Admin config file: cli/seeder-config.json (gitignored)
 *   {
 *     "superAdminEmail": "you@example.com",
 *     "superAdminPassword": "strong-password-here",
 *     "superAdminDisplayName": "System Owner"
 *   }
 *
 * If the file is missing, callers should prompt interactively and pass the
 * values in the config object instead.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vault = require('./vault.js');

/* ─────────────────────────────────────────────
 * RESOLVE SEEDER CONFIG FILE
 * ───────────────────────────────────────────── */

/**
 * Resolve the canonical path to the super-admin seeder config.
 * cli/lib/seeder.js → cli/lib/ → cli/ → seeder-config.json
 */
const SEEDER_CONFIG_PATH = path.resolve(__dirname, '..', 'seeder-config.json');

/**
 * Read the super-admin credentials from cli/seeder-config.json.
 * Returns { success, data } or { success: false, error }.
 *
 * @returns {{ success: boolean, data?: Object, error?: string }}
 */
function readSeederConfig() {
  if (!fs.existsSync(SEEDER_CONFIG_PATH)) {
    return {
      success: false,
      error: `Seeder config not found at "${SEEDER_CONFIG_PATH}".\n` +
             `Create it with:\n` +
             `  {\n` +
             `    "superAdminEmail": "you@example.com",\n` +
             `    "superAdminPassword": "strong-password-here",\n` +
             `    "superAdminDisplayName": "System Owner"\n` +
             `  }`,
    };
  }

  let raw, parsed;
  try {
    raw = fs.readFileSync(SEEDER_CONFIG_PATH, 'utf-8');
    parsed = JSON.parse(raw);
  } catch (e) {
    return { success: false, error: `Failed to parse seeder-config.json: ${e.message}` };
  }

  if (!parsed.superAdminEmail || !parsed.superAdminPassword) {
    return {
      success: false,
      error: 'Seeder config must include superAdminEmail and superAdminPassword.',
    };
  }

  return { success: true, data: parsed };
}

/* ─────────────────────────────────────────────
 * ROLE CONSTANTS
 * ───────────────────────────────────────────── */

const ROLES = {
  SUPER_ADMIN: 'super_admin',
  ADMIN: 'admin',
  USER: 'user',
  GUEST: 'guest',
};

/* ─────────────────────────────────────────────
 * COLLECTION / DOCUMENT PATHS
 * ───────────────────────────────────────────── */

const COLLECTIONS = {
  EMPLOYEES: 'employees',
  SYSTEM: 'system',
  SYSTEM_STATUS: 'system_status',
};

const DOCS = {
  SYSTEM_CONFIG: 'config',      // /system/config
  SYSTEM_STATUS_CONFIG: 'config', // /system_status/config
};

/* ─────────────────────────────────────────────
 * HELPER: TIMESTAMP
 * ───────────────────────────────────────────── */

/**
 * Return a Firestore server-timestamp sentinel, or a JS Date for
 * client-side date fields. We use admin.firestore.FieldValue.serverTimestamp()
 * where possible, and plain JS Date for schema fields that need a specific value.
 */
function nowISO() {
  return new Date().toISOString();
}

/**
 * Calculate end date by adding months.
 * @param {number} months
 * @returns {string} ISO 8601 date string
 */
function addMonths(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + (months || 12));
  return d.toISOString();
}

/* ─────────────────────────────────────────────
 * 3.1 — SEED SUPER ADMIN
 * ───────────────────────────────────────────── */

/**
 * Create (or update) the fixed super_admin account.
 *
 * This account:
 *   - Is created in Firebase Auth with email + password + display name
 *   - Gets a Firestore document at /employees/{uid} with role='super_admin'
 *   - Bypasses all subscription locks (checked by the frontend's VisionLicensing)
 *
 * The credentials come from cli/seeder-config.json (or a caller-provided override).
 *
 * Idempotent: if the email already exists in Auth, we fetch the existing UID
 * and update the Firestore document instead of failing.
 *
 * @param {{ auth: import('firebase-admin').auth.Auth, db: import('firebase-admin').firestore.Firestore }} adminApp
 *   — destructured from getAdminApp() result
 * @param {{ superAdminEmail: string, superAdminPassword: string, superAdminDisplayName?: string }} config
 * @returns {Promise<{ success: boolean, uid?: string, created?: boolean, updated?: boolean, error?: string }>}
 */
async function seedSuperAdmin(adminApp, config) {
  const { auth, db } = adminApp;

  if (!config.superAdminEmail || !config.superAdminPassword) {
    return {
      success: false,
      error: 'Missing superAdminEmail or superAdminPassword in config.',
    };
  }

  const displayName = config.superAdminDisplayName || 'System Owner';
  const email = config.superAdminEmail.trim().toLowerCase();

  let uid;
  let created = false;
  let updated = false;

  try {
    // Check if the user already exists
    try {
      const existingUser = await auth.getUserByEmail(email);
      uid = existingUser.uid;

      // Update password + display name on existing user
      await auth.updateUser(uid, {
        password: config.superAdminPassword,
        displayName: displayName,
      });
      updated = true;
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        // Create new user
        const newUser = await auth.createUser({
          email: email,
          password: config.superAdminPassword,
          displayName: displayName,
          emailVerified: true, // skip verification for the owner
        });
        uid = newUser.uid;
        created = true;
      } else {
        throw e;
      }
    }

    // Write /employees/{uid} document
    const employeeDoc = {
      uid: uid,
      email: email,
      displayName: displayName,
      role: ROLES.SUPER_ADMIN,
      isActive: true,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      createdBy: 'seeder',
      _seeded: true,
    };

    await db.collection(COLLECTIONS.EMPLOYEES).doc(uid).set(employeeDoc, { merge: true });

    return {
      success: true,
      uid,
      created,
      updated: updated && !created,
    };
  } catch (error) {
    return {
      success: false,
      uid: uid || null,
      error: `seedSuperAdmin failed: ${error.message}`,
    };
  }
}

/* ─────────────────────────────────────────────
 * 3.2 — SEED CLIENT ADMIN
 * ───────────────────────────────────────────── */

/**
 * Create (or update) the client's admin account.
 *
 * Credentials come from the .env file: ADMIN_EMAIL, ADMIN_PASSWORD.
 * The account is subject to subscription locks (role='admin').
 *
 * Idempotent: updates password + Firestore doc if the email already exists.
 *
 * @param {{ auth: import('firebase-admin').auth.Auth, db: import('firebase-admin').firestore.Firestore }} adminApp
 * @param {{ ADMIN_EMAIL: string, ADMIN_PASSWORD: string, CLIENT_BRAND?: string }} config
 * @returns {Promise<{ success: boolean, uid?: string, created?: boolean, updated?: boolean, error?: string }>}
 */
async function seedClientAdmin(adminApp, config) {
  const { auth, db } = adminApp;

  if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) {
    return {
      success: false,
      error: 'Missing ADMIN_EMAIL or ADMIN_PASSWORD in config. Check the .env file.',
    };
  }

  const email = config.ADMIN_EMAIL.trim().toLowerCase();
  const displayName = config.CLIENT_BRAND
    ? `مدير ${config.CLIENT_BRAND}`
    : 'مدير النظام';

  let uid;
  let created = false;
  let updated = false;

  try {
    // Check if the user already exists
    try {
      const existingUser = await auth.getUserByEmail(email);
      uid = existingUser.uid;

      // Update password + display name
      await auth.updateUser(uid, {
        password: config.ADMIN_PASSWORD,
        displayName: displayName,
      });
      updated = true;
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        // Create new user
        const newUser = await auth.createUser({
          email: email,
          password: config.ADMIN_PASSWORD,
          displayName: displayName,
          emailVerified: true,
        });
        uid = newUser.uid;
        created = true;
      } else {
        throw e;
      }
    }

    // Write /employees/{uid} document
    const employeeDoc = {
      uid: uid,
      email: email,
      displayName: displayName,
      role: ROLES.ADMIN,
      isActive: true,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      createdBy: 'seeder',
      _seeded: true,
    };

    await db.collection(COLLECTIONS.EMPLOYEES).doc(uid).set(employeeDoc, { merge: true });

    return {
      success: true,
      uid,
      created,
      updated: updated && !created,
    };
  } catch (error) {
    return {
      success: false,
      uid: uid || null,
      error: `seedClientAdmin failed: ${error.message}`,
    };
  }
}

/* ─────────────────────────────────────────────
 * 3.3 — SEED SYSTEM CONFIG
 * ───────────────────────────────────────────── */

/**
 * Write the /system/config Firestore document.
 *
 * This document drives:
 *   - window.CLIENT_BRAND    (brandName)
 *   - window.ALLOWED_EMAILS  (allowedEmails — login whitelist)
 *   - window.CLIENT_DATA     (settings, etc.)
 *
 * Idempotent: uses set() with merge:true.
 *
 * @param {{ db: import('firebase-admin').firestore.Firestore }} adminApp
 * @param {{
 *   CLIENT_BRAND?: string,
 *   ADMIN_EMAIL?: string,
 *   CLIENT_ID?: string,
 *   settings?: Object
 * }} config
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function seedSystemConfig(adminApp, config) {
  const { db } = adminApp;

  const brandName = config.CLIENT_BRAND || config.CLIENT_ID || 'نظام الإدارة';
  const allowedEmails = [];

  // Add super admin email if available
  if (config.superAdminEmail) {
    allowedEmails.push(config.superAdminEmail.trim().toLowerCase());
  }

  // Add client admin email
  if (config.ADMIN_EMAIL) {
    const adminEmail = config.ADMIN_EMAIL.trim().toLowerCase();
    if (!allowedEmails.includes(adminEmail)) {
      allowedEmails.push(adminEmail);
    }
  }

  const systemConfigDoc = {
    brandName: brandName,
    brand: brandName,
    clientId: config.CLIENT_ID || '',
    allowedEmails: allowedEmails,
    settings: config.settings || {
      defaultLanguage: 'ar',
      timezone: 'Africa/Cairo',
      currency: 'EGP',
      dateFormat: 'DD/MM/YYYY',
    },
    createdAt: nowISO(),
    updatedAt: nowISO(),
    _seeded: true,
  };

  try {
    await db
      .collection(COLLECTIONS.SYSTEM)
      .doc(DOCS.SYSTEM_CONFIG)
      .set(systemConfigDoc, { merge: true });

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: `seedSystemConfig failed: ${error.message}`,
    };
  }
}

/* ─────────────────────────────────────────────
 * 3.4 — SEED SUBSCRIPTION
 * ───────────────────────────────────────────── */

/**
 * Write the /system_status/config Firestore document.
 *
 * This document drives the licensing system (VisionLicensing):
 *   - isActive: whether the tenant is currently active
 *   - startDate / endDate: subscription window
 *   - subscriptionHistory: audit trail of renewals/changes
 *   - usageCaps: soft limits enforced by the frontend
 *
 * Idempotent: uses set() with merge:true.
 *
 * @param {{ db: import('firebase-admin').firestore.Firestore }} adminApp
 * @param {{
 *   SUBSCRIPTION_MONTHS?: number|string,
 *   CLIENT_ID?: string,
 *   ADMIN_EMAIL?: string
 * }} config
 * @returns {Promise<{ success: boolean, endDate?: string, error?: string }>}
 */
async function seedSubscription(adminApp, config) {
  const { db } = adminApp;

  const months = parseInt(config.SUBSCRIPTION_MONTHS, 10) || 12;
  const startDate = nowISO();
  const endDate = addMonths(months);

  const subscriptionDoc = {
    isActive: true,
    startDate: startDate,
    endDate: endDate,
    subscriptionMonths: months,
    subscriptionHistory: [
      {
        action: 'initial',
        months: months,
        startDate: startDate,
        endDate: endDate,
        timestamp: startDate,
        note: 'Initial subscription created by seeder.',
      },
    ],
    usageCaps: {
      maxEmployees: 10,
      maxProducts: 500,
      maxOrders: 10000,
      maxStorageMB: 500,
    },
    maintenanceMode: false,
    createdAt: startDate,
    updatedAt: startDate,
    _seeded: true,
  };

  try {
    await db
      .collection(COLLECTIONS.SYSTEM_STATUS)
      .doc(DOCS.SYSTEM_STATUS_CONFIG)
      .set(subscriptionDoc, { merge: true });

    return { success: true, endDate };
  } catch (error) {
    return {
      success: false,
      error: `seedSubscription failed: ${error.message}`,
    };
  }
}

/* ─────────────────────────────────────────────
 * 3.5 — SEED ALL (ORCHESTRATOR)
 * ───────────────────────────────────────────── */

/**
 * Run the full seeding sequence for a new client.
 *
 * Order:
 *   1. seedSuperAdmin  — the locked owner (from seeder-config or caller-provided)
 *   2. seedClientAdmin  — tenant admin from .env
 *   3. seedSystemConfig — /system/config
 *   4. seedSubscription — /system_status/config
 *
 * Each step is logged. Failures are collected but subsequent steps continue
 * (non-fatal per-step), then reported in the summary.
 *
 * @param {{
 *   auth: import('firebase-admin').auth.Auth,
 *   db: import('firebase-admin').firestore.Firestore
 * }} adminApp — from getAdminApp()
 * @param {Object} config — merged config: seeder-config.json + .env data
 * @param {Function} [log] — optional logger function (msg) => void
 * @returns {Promise<{
 *   success: boolean,
 *   summary: Array<{ step: string, success: boolean, detail?: string, error?: string }>,
 *   allSucceeded: boolean,
 *   superAdminUid?: string,
 *   clientAdminUid?: string,
 *   subscriptionEndDate?: string
 * }>}
 */
async function seedAll(adminApp, config, log) {
  const print = log || (() => {}); // no-op if no logger provided

  print('═══ Seeding database ═══');

  const summary = [];
  let superAdminUid = null;
  let clientAdminUid = null;
  let subscriptionEndDate = null;

  // Step 1: Super Admin
  print('  [1/4] Seeding super admin…');
  const saResult = await seedSuperAdmin(adminApp, config);
  summary.push({
    step: 'seedSuperAdmin',
    success: saResult.success,
    detail: saResult.created
      ? `Created new super_admin (uid: ${saResult.uid})`
      : saResult.updated
        ? `Updated existing super_admin (uid: ${saResult.uid})`
        : null,
    error: saResult.error || null,
  });
  if (saResult.success) {
    superAdminUid = saResult.uid;
    print(`  ✓ Super admin — ${saResult.created ? 'created' : 'updated'} (${saResult.uid})`);
  } else {
    print(`  ✖ Super admin FAILED: ${saResult.error}`);
  }

  // Step 2: Client Admin
  print('  [2/4] Seeding client admin…');
  const caResult = await seedClientAdmin(adminApp, config);
  summary.push({
    step: 'seedClientAdmin',
    success: caResult.success,
    detail: caResult.created
      ? `Created new admin (uid: ${caResult.uid})`
      : caResult.updated
        ? `Updated existing admin (uid: ${caResult.uid})`
        : null,
    error: caResult.error || null,
  });
  if (caResult.success) {
    clientAdminUid = caResult.uid;
    print(`  ✓ Client admin — ${caResult.created ? 'created' : 'updated'} (${caResult.uid})`);
  } else {
    print(`  ✖ Client admin FAILED: ${caResult.error}`);
  }

  // Step 3: System Config
  print('  [3/4] Seeding system config…');
  const scResult = await seedSystemConfig(adminApp, config);
  summary.push({
    step: 'seedSystemConfig',
    success: scResult.success,
    error: scResult.error || null,
  });
  if (scResult.success) {
    print(`  ✓ System config written (/system/config)`);
  } else {
    print(`  ✖ System config FAILED: ${scResult.error}`);
  }

  // Step 4: Subscription
  print('  [4/4] Seeding subscription…');
  const subResult = await seedSubscription(adminApp, config);
  summary.push({
    step: 'seedSubscription',
    success: subResult.success,
    detail: subResult.endDate ? `End date: ${subResult.endDate}` : null,
    error: subResult.error || null,
  });
  if (subResult.success) {
    subscriptionEndDate = subResult.endDate;
    print(`  ✓ Subscription seeded (end: ${subResult.endDate})`);
  } else {
    print(`  ✖ Subscription FAILED: ${subResult.error}`);
  }

  const allSucceeded = summary.every(s => s.success);

  print('');
  if (allSucceeded) {
    print('✓ All seeding steps completed successfully.');
  } else {
    const failed = summary.filter(s => !s.success).map(s => s.step).join(', ');
    print(`⚠ Seeding completed with failures: ${failed}`);
  }

  return {
    success: allSucceeded,
    summary,
    allSucceeded,
    superAdminUid,
    clientAdminUid,
    subscriptionEndDate,
  };
}

/* ─────────────────────────────────────────────
 * CONVENIENCE: FULL PIPELINE FOR CREATE-CLIENT
 * ───────────────────────────────────────────── */

/**
 * Convenience function that loads the seeder config, initializes the Admin SDK,
 * merges the .env data, and runs seedAll().
 *
 * This is the "one call" entry point for create-client.js after the wizard
 * collects all inputs.
 *
 * @param {string} clientId
 * @param {Object} [options]
 * @param {Object} [options.seederConfig] — override super admin creds (if config file missing)
 * @param {boolean} [options.skipSuperAdmin] — skip super admin seeding (e.g. already exists)
 * @param {Function} [options.log] — log function
 * @returns {Promise<Object>} seedAll result
 */
async function seedClient(clientId, options = {}) {
  // Load seeder config (super admin credentials)
  const seederConfigResult = options.seederConfig
    ? { success: true, data: options.seederConfig }
    : readSeederConfig();

  if (!seederConfigResult.success && !options.skipSuperAdmin) {
    return {
      success: false,
      error: seederConfigResult.error,
      hint: 'Create cli/seeder-config.json or pass { seederConfig: {...} } in options.',
    };
  }

  // Load .env from vault
  const envData = vault.readEnvTransparent(clientId);

  // Merge configs
  const mergedConfig = {
    ...envData,
    ...(seederConfigResult.data || {}),
    CLIENT_ID: clientId,
  };

  // Initialize Admin SDK
  const firebaseAdmin = require('./firebase-admin.js');
  const adminResult = await firebaseAdmin.getAdminApp(clientId);

  if (!adminResult.success) {
    return {
      success: false,
      error: `Failed to initialize Admin SDK: ${adminResult.error}`,
    };
  }

  // Run seeding
  const result = await seedAll(
    { auth: adminResult.auth, db: adminResult.db },
    mergedConfig,
    options.log
  );

  // Cleanup
  await firebaseAdmin.destroyApp(clientId);

  return result;
}

/* ─────────────────────────────────────────────
 * EXPORTS
 * ───────────────────────────────────────────── */

module.exports = {
  // Core seeders
  seedSuperAdmin,
  seedClientAdmin,
  seedSystemConfig,
  seedSubscription,
  seedAll,

  // Convenience
  seedClient,
  readSeederConfig,

  // Constants
  ROLES,
  COLLECTIONS,
  DOCS,
  SEEDER_CONFIG_PATH,
};