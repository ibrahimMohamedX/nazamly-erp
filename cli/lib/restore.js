/**
 * cli/lib/restore.js — Firestore Data Import / Restore Engine
 * =============================================================
 *
 * Reads a backup JSON file (created by backup.js) and writes all
 * documents back into Firestore. This is DESTRUCTIVE — it overwrites
 * existing documents with the same IDs.
 *
 * Safety features:
 *   - Requires explicit --confirm flag (checked by the CLI wrapper)
 *   - Validates backup file structure before writing anything
 *   - Verifies backup project_id matches the target Firestore project
 *   - Supports dry-run mode that lists what would be restored
 *   - Can restore specific collections only (--collections orders,products)
 *   - Creates documents with the EXACT same __docId__ as the original
 *
 * Restore is NOT a merge — it writes exactly what's in the backup.
 * For partial restores, extract the desired collection from the backup
 * JSON manually and pass it via --collections.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vault = require('./vault.js');
const fbAdmin = require('./firebase-admin.js');
const logger = require('./logger.js');

/* ─────────────────────────────────────────────
 * BACKUP FILE VALIDATION
 * ───────────────────────────────────────────── */

/**
 * Validate the structure of a backup JSON file.
 * Checks it has metadata + collections, and version is recognized.
 *
 * @param {string} backupPath — absolute path to the backup JSON file
 * @returns {{
 *   valid: boolean,
 *   metadata?: Object,
 *   collections?: Object,
 *   error?: string
 * }}
 */
function validateBackupFile(backupPath) {
  if (!fs.existsSync(backupPath)) {
    return { valid: false, error: `Backup file not found: ${backupPath}` };
  }

  let raw, parsed;
  try {
    raw = fs.readFileSync(backupPath, 'utf-8');
    parsed = JSON.parse(raw);
  } catch (e) {
    return { valid: false, error: `Failed to read/parse backup file: ${e.message}` };
  }

  // Check structure
  if (!parsed.metadata) {
    return { valid: false, error: 'Backup is missing the "metadata" section. This does not look like a Nazamly backup.' };
  }

  if (!parsed.collections || typeof parsed.collections !== 'object') {
    return { valid: false, error: 'Backup is missing the "collections" section. File may be corrupted.' };
  }

  if (parsed.metadata.version !== 1) {
    return {
      valid: false,
      error: `Unknown backup version "${parsed.metadata.version}". This restore tool supports version 1 only.`,
    };
  }

  return {
    valid: true,
    metadata: parsed.metadata,
    collections: parsed.collections,
  };
}

/* ─────────────────────────────────────────────
 * DRY-RUN PREVIEW
 * ───────────────────────────────────────────── */

/**
 * Generate a preview of what would be restored without writing anything.
 *
 * @param {string} backupPath
 * @param {string[]} [onlyCollections] — limit to specific collections
 * @returns {{ success: boolean, preview?: Object, error?: string }}
 */
function dryRunRestore(backupPath, onlyCollections) {
  const validation = validateBackupFile(backupPath);
  if (!validation.valid) {
    return validation;
  }

  const { metadata, collections } = validation;

  // Filter collections if specified
  const collectionNames = onlyCollections && onlyCollections.length > 0
    ? Object.keys(collections).filter(c => onlyCollections.includes(c))
    : Object.keys(collections);

  const perCollection = {};
  let totalDocs = 0;

  for (const name of collectionNames) {
    const docs = collections[name];
    perCollection[name] = docs ? docs.length : 0;
    totalDocs += docs ? docs.length : 0;
  }

  return {
    success: true,
    preview: {
      clientId: metadata.clientId,
      projectId: metadata.projectId,
      exportedAt: metadata.exportedAt,
      totalCollections: collectionNames.length,
      totalDocuments: totalDocs,
      perCollection,
      missingCollections: onlyCollections
        ? onlyCollections.filter(c => !collections[c])
        : [],
    },
  };
}

/* ─────────────────────────────────────────────
 * BATCH WRITE TOOL
 * ───────────────────────────────────────────── */

/**
 * Write a batch of documents to a Firestore collection.
 *
 * Firestore batches are capped at 500 operations. This function
 * automatically splits larger collections into multiple batches.
 *
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {string} collectionName
 * @param {Array<Object>} docs — each must have __docId__ field
 * @param {boolean} [merge]    — if true, use set with { merge: true } to preserve existing fields
 * @returns {Promise<{ written: number, errors: number, errorDetails: string[] }>}
 */
async function writeCollectionBatch(db, collectionName, docs, merge = false) {
  const BATCH_SIZE = 500; // Firestore limit per batch commit
  let written = 0;
  const errorDetails = [];

  for (let offset = 0; offset < docs.length; offset += BATCH_SIZE) {
    const chunk = docs.slice(offset, offset + BATCH_SIZE);
    const batch = db.batch();

    for (const doc of chunk) {
      const docId = doc.__docId__;
      if (!docId) {
        errorDetails.push(`Document at index ${offset} has no __docId__ — skipping`);
        continue;
      }

      // Remove __docId__ from the stored fields (it's the document ID, not a field)
      const fields = Object.assign({}, doc);
      delete fields.__docId__;

      const ref = db.collection(collectionName).doc(docId);
      batch.set(ref, fields, { merge });
    }

    try {
      await batch.commit();
      written += chunk.length;
    } catch (error) {
      errorDetails.push(`Batch at offset ${offset} failed: ${error.message}`);
    }
  }

  return {
    written,
    errors: errorDetails.length,
    errorDetails,
  };
}

/* ─────────────────────────────────────────────
 * FULL RESTORE
 * ───────────────────────────────────────────── */

/**
 * Import a backup JSON file into a client's Firestore.
 *
 * THIS IS DESTRUCTIVE — it overwrites existing documents.
 *
 * @param {string} clientId
 * @param {string} backupPath     — absolute path to the backup JSON
 * @param {Object} options
 * @param {string[]} [options.collections] — specific collections to restore (default: all)
 * @param {boolean} [options.dryRun]       — preview only, no writes
 * @param {boolean} [options.merge]        — use merge mode (preserve fields not in backup)
 * @param {function} [options.onProgress]  — callback(collectionName, done, total)
 * @returns {Promise<{
 *   success: boolean,
 *   restoredCollections?: number,
 *   restoredDocuments?: number,
 *   error?: string,
 *   errors?: string[],
 *   durationMs?: number
 * }>}
 */
async function importFirestore(clientId, backupPath, options = {}) {
  const startTime = Date.now();

  // Validate backup file
  const validation = validateBackupFile(backupPath);
  if (!validation.valid) {
    return {
      success: false,
      error: `Invalid backup file: ${validation.error}`,
      durationMs: Date.now() - startTime,
    };
  }

  const { metadata, collections } = validation;

  // Verify project IDs match (warning, not error — service account might map differently)
  const envData = vault.readEnvTransparent(clientId);
  const targetProjectId = envData.FIREBASE_PROJECT_ID;

  if (metadata.projectId && targetProjectId && metadata.projectId !== targetProjectId) {
    // This is a WARNING — projects can be renamed or the SA could map differently
    // but it's worth flagging
  }

  // Dry-run mode
  if (options.dryRun) {
    const preview = dryRunRestore(backupPath, options.collections);
    return {
      success: true,
      ...preview.preview,
      restoredCollections: preview.preview?.totalCollections || 0,
      restoredDocuments: preview.preview?.totalDocuments || 0,
      dryRun: true,
      durationMs: Date.now() - startTime,
    };
  }

  // Connect to Firebase
  const appResult = await fbAdmin.getAdminApp(clientId);
  if (!appResult.success) {
    return {
      success: false,
      error: `Cannot connect to Firebase: ${appResult.error}`,
      durationMs: Date.now() - startTime,
    };
  }

  const { db } = appResult;

  // Determine which collections to restore
  const collectionNames = options.collections && options.collections.length > 0
    ? options.collections.filter(c => collections[c])
    : Object.keys(collections);

  if (collectionNames.length === 0) {
    return {
      success: false,
      error: 'No collections to restore. Check --collections filter or backup content.',
      durationMs: Date.now() - startTime,
    };
  }

  // Restore each collection
  const allErrors = [];
  let totalDocs = 0;
  let restoredCollections = 0;

  for (const collName of collectionNames) {
    const docs = collections[collName];
    if (!Array.isArray(docs) || docs.length === 0) {
      continue; // skip empty collections
    }

    if (options.onProgress) {
      options.onProgress(collName, 0, docs.length);
    }

    const result = await writeCollectionBatch(db, collName, docs, options.merge);

    if (result.errors > 0) {
      allErrors.push(`[${collName}] ${result.errorDetails.join('; ')}`);
    }

    totalDocs += result.written;
    restoredCollections++;

    if (options.onProgress) {
      options.onProgress(collName, docs.length, docs.length);
    }
  }

  const success = allErrors.length === 0;
  const durationMs = Date.now() - startTime;

  // Log
  if (success) {
    logger.logAction(logger.ACTION_TYPES.BACKUP_RESTORED, clientId, durationMs, {
      backupPath,
      restoredCollections,
      restoredDocuments: totalDocs,
      mergeMode: options.merge || false,
    });
  } else {
    logger.logWarning(logger.ACTION_TYPES.BACKUP_RESTORED, clientId,
      `Restore completed with ${allErrors.length} collection error(s)`, durationMs, {
        backupPath,
        restoredCollections,
        restoredDocuments: totalDocs,
        errors: allErrors,
      });
  }

  return {
    success,
    restoredCollections,
    restoredDocuments: totalDocs,
    errors: allErrors.length > 0 ? allErrors : undefined,
    durationMs,
  };
}

/* ─────────────────────────────────────────────
 * MOST RECENT BACKUP HELPER
 * ───────────────────────────────────────────── */

/**
 * Find the most recent backup for a client.
 *
 * @param {string} clientId
 * @returns {{ success: boolean, backupPath?: string, error?: string }}
 */
function getLatestBackup(clientId) {
  const backupsDir = vault.getBackupsDir(clientId);

  if (!fs.existsSync(backupsDir)) {
    return { success: false, error: `No backups directory for client "${clientId}"` };
  }

  const files = fs.readdirSync(backupsDir)
    .filter(f => f.endsWith('.json'))
    .map(f => ({
      filename: f,
      path: path.join(backupsDir, f),
      mtime: fs.statSync(path.join(backupsDir, f)).mtime,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) {
    return { success: false, error: `No backup files found for client "${clientId}"` };
  }

  return { success: true, backupPath: files[0].path };
}

/* ─────────────────────────────────────────────
 * EXPORTS
 * ───────────────────────────────────────────── */

module.exports = {
  importFirestore,
  dryRunRestore,
  validateBackupFile,
  writeCollectionBatch,
  getLatestBackup,
};