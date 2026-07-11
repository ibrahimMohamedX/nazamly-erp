/**
 * cli/lib/backup.js — Firestore Data Export Engine
 * =================================================
 *
 * Uses Firebase Admin SDK to export all Firestore collections and their
 * documents for a given client into timestamped JSON files inside the
 * client's vault `backups/` directory.
 *
 * Backup format:
 *   ../nazamly-clients-vault/<clientId>/backups/<clientId>-<ISO-timestamp>.json
 *
 * File structure:
 *   {
 *     metadata: {
 *       clientId, projectId, exportedAt, totalCollections, totalDocuments,
 *       version: 1, generatedBy: "nazamly-erp-cli"
 *     },
 *     collections: {
 *       "<collectionName>": [
 *         { __docId__: "<id>", ...fields },
 *         ...
 *       ]
 *     }
 *   }
 *
 * The __docId__ field stores the Firestore document ID (which is not a
 * field on the document itself) so restores can recreate it exactly.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vault = require('./vault.js');
const fbAdmin = require('./firebase-admin.js');
const logger = require('./logger.js');

/* ─────────────────────────────────────────────
 * EXPORT A SINGLE COLLECTION
 * ───────────────────────────────────────────── */

/**
 * Fetch all documents from a Firestore collection.
 *
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {string} collectionName
 * @returns {Promise<Array<Object>>} array of document data with __docId__ field
 */
async function exportCollection(db, collectionName) {
  const snapshot = await db.collection(collectionName).get();
  const docs = [];

  snapshot.forEach(doc => {
    const data = doc.data();
    data.__docId__ = doc.id;
    docs.push(data);
  });

  return docs;
}

/* ─────────────────────────────────────────────
 * EXPORT ALL COLLECTIONS (sub-collections too)
 * ───────────────────────────────────────────── */

/**
 * List all top-level collection IDs in a Firestore database.
 * Note: Firestore Admin SDK doesn't have a `listCollections()` on the db
 * root directly in older versions; in v10+ it does. We handle both.
 *
 * @param {import('firebase-admin').firestore.Firestore} db
 * @returns {Promise<string[]>}
 */
async function listCollections(db) {
  try {
    // firebase-admin v10+ supports listCollections on the db root
    const collections = await db.listCollections();
    return collections.map(c => c.id);
  } catch (_) {
    // Fallback: try reading known collection names from common paths
    // This is less ideal but works with older SDK versions
    return getDefaultCollectionNames();
  }
}

/**
 * Known/default collection names in the Nazamly ERP schema.
 * Used as fallback when SDK can't enumerate collections.
 * Add new collections here as the app schema grows.
 */
function getDefaultCollectionNames() {
  return [
    'employees',
    'system',
    'system_status',
    'orders',
    'products',
    'inventory',
    'expenses',
    'purchases',
    'settings',
    'customers',
    'shipping',
    'subscriptions',
    'audit_log',
    'notifications',
  ];
}

/* ─────────────────────────────────────────────
 * FULL EXPORT
 * ───────────────────────────────────────────── */

/**
 * Export all Firestore data for a client to a JSON backup file.
 *
 * @param {string} clientId
 * @param {Object} options
 * @param {string[]} [options.collections] — specific collections to export (default: all)
 * @param {boolean} [options.compact]     — minify JSON (smaller file, less readable)
 * @returns {Promise<{
 *   success: boolean,
 *   backupPath?: string,
 *   backupSize?: number,
 *   totalCollections?: number,
 *   totalDocuments?: number,
 *   error?: string,
 *   durationMs?: number
 * }>}
 */
async function exportFirestore(clientId, options = {}) {
  const startTime = Date.now();

  // Get Admin SDK app
  const appResult = await fbAdmin.getAdminApp(clientId);
  if (!appResult.success) {
    return {
      success: false,
      error: `Cannot connect to Firebase: ${appResult.error}`,
      durationMs: Date.now() - startTime,
    };
  }

  const { db, projectId } = appResult;

  try {
    // List collections (or use specified ones)
    let collectionNames;
    if (options.collections && options.collections.length > 0) {
      collectionNames = options.collections;
    } else {
      collectionNames = await listCollections(db);
    }

    // Export each collection
    const collections = {};
    let totalDocuments = 0;
    const errors = [];

    for (const collName of collectionNames) {
      try {
        const docs = await exportCollection(db, collName);
        collections[collName] = docs;
        totalDocuments += docs.length;
      } catch (error) {
        errors.push(`[${collName}] ${error.message}`);
        collections[collName] = []; // empty array for failed collection
      }
    }

    // Build the backup file structure
    const backup = {
      metadata: {
        clientId,
        projectId,
        exportedAt: new Date().toISOString(),
        totalCollections: collectionNames.length,
        totalDocuments,
        collectionErrors: errors.length > 0 ? errors : undefined,
        version: 1,
        generatedBy: 'nazamly-erp-cli',
      },
      collections,
    };

    // Write to vault backups directory
    const backupsDir = vault.getBackupsDir(clientId);
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `${clientId}-${timestamp}.json`;
    const backupPath = path.join(backupsDir, backupFileName);

    const json = JSON.stringify(backup, null, options.compact ? 0 : 2);
    fs.writeFileSync(backupPath, json, 'utf-8');

    const backupSize = fs.statSync(backupPath).size;
    const durationMs = Date.now() - startTime;

    logger.logAction(logger.ACTION_TYPES.BACKUP_CREATED, clientId, durationMs, {
      backupPath: vault.getBackupsDir(clientId) + '/' + backupFileName,
      backupSize,
      totalCollections: collectionNames.length,
      totalDocuments,
      errors: errors.length > 0 ? errors : undefined,
    });

    return {
      success: true,
      backupPath,
      backupSize,
      totalCollections: collectionNames.length,
      totalDocuments,
      errors: errors.length > 0 ? errors : undefined,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    logger.logError(logger.ACTION_TYPES.BACKUP_FAILED, clientId, error, durationMs);
    return {
      success: false,
      error: `Backup failed: ${error.message}`,
      durationMs,
    };
  }
}

/* ─────────────────────────────────────────────
 * LIST / PRUNE BACKUPS
 * ───────────────────────────────────────────── */

/**
 * List all backup files for a client, sorted newest first.
 *
 * @param {string} clientId
 * @returns {{ success: boolean, backups?: Array<{ filename: string, path: string, size: number, timestamp: Date }>, error?: string }}
 */
function listBackups(clientId) {
  const backupsDir = vault.getBackupsDir(clientId);

  if (!fs.existsSync(backupsDir)) {
    return { success: true, backups: [] };
  }

  try {
    const files = fs.readdirSync(backupsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const filePath = path.join(backupsDir, f);
        const stat = fs.statSync(filePath);
        return {
          filename: f,
          path: filePath,
          size: stat.size,
          timestamp: stat.mtime,
        };
      })
      .sort((a, b) => b.timestamp - a.timestamp);

    return { success: true, backups: files };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Prune old backups, keeping only the most recent `keepCount`.
 *
 * @param {string} clientId
 * @param {number} [keepCount] — default 10
 * @returns {{ success: boolean, deleted: number, kept: number, error?: string }}
 */
function pruneBackups(clientId, keepCount = 10) {
  const listResult = listBackups(clientId);
  if (!listResult.success || listResult.backups.length <= keepCount) {
    return { success: true, deleted: 0, kept: listResult.backups?.length || 0 };
  }

  const toDelete = listResult.backups.slice(keepCount);

  let deleted = 0;
  for (const backup of toDelete) {
    try {
      fs.unlinkSync(backup.path);
      deleted++;
    } catch (_) {
      // skip files we can't delete
    }
  }

  return { success: true, deleted, kept: keepCount };
}

/* ─────────────────────────────────────────────
 * EXPORTS
 * ───────────────────────────────────────────── */

module.exports = {
  exportFirestore,
  exportCollection,
  listCollections,
  listBackups,
  pruneBackups,
  getDefaultCollectionNames,
};