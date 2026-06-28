/**
 * VisionFirebase — Firestore Real-time Sync
 * ==========================================
 * Bridges Firestore documents to VisionConfig, VisionOverlays,
 * VisionNotifications, and VisionAuth.
 *
 * Collections (with optional prefix):
 *   /system/status           – maintenance mode & system status
 *   /<prefix>notifications   – broadcast notifications
 *   /subscriptions/{uid}     – per-user subscription data
 *
 * Usage:
 *   await VisionFirebase.init({ offlinePersistence: true });
 *   VisionFirebase.syncSystemStatus();
 *   VisionFirebase.syncNotifications({ limit: 15 });
 *   VisionFirebase.syncSubscription(user.uid);
 *
 *   // Admin helpers:
 *   await VisionFirebase.setMaintenanceMode({ enabled: true, endTime: '2026-07-01T06:00:00Z' });
 *   await VisionFirebase.sendNotification({ type: 'info', title: 'مرحباً', message: '…' });
 *   await VisionFirebase.updateSystemStatus({ status: 'operational' });
 *
 *   VisionFirebase.disconnect(); // cleanup all listeners
 */
(function (window) {
  "use strict";

  /* ─────────────────────────────────────────────
   * INTERNAL STATE
   * ───────────────────────────────────────────── */
  const _ctx = {
    initialized: false,
    db: null,
    prefix: "",
    offline: false,
  };

  /** Active Firestore unsubscribe functions */
  const _unsubs = {};

  /* ─────────────────────────────────────────────
   * HELPERS
   * ───────────────────────────────────────────── */

  /** Resolve a collection name with the configured prefix */
  function _col(name) {
    return _ctx.prefix ? _ctx.prefix + "_" + name : name;
  }

  /** Convert a Firestore Timestamp or a raw value to a JS Date */
  function _toDate(v) {
    if (!v) return null;
    if (typeof v.toDate === "function") return v.toDate();
    return new Date(v);
  }

  /** Log prefix */
  function _log(msg) {
    console.log("[VisionFirebase] " + msg);
  }
  function _err(msg, e) {
    console.error("[VisionFirebase] " + msg, e || "");
  }

  /**
   * Gracefully handle a Firestore error: log it, show a non-blocking warning,
   * and continue with local state.
   */
  function _handleError(error, context) {
    _err(context + " error:", error);
    if (window.VisionOverlays) {
      window.VisionOverlays.toast({
        type: "warning",
        title: "تحذير: مشكلة في الاتصال",
        message:
          "النظام يعمل بالبيانات المحلية. بعض المعلومات قد لا تكون محدثة.",
        duration: 8000,
      });
    }
  }

  /* ─────────────────────────────────────────────
   * PUBLIC API
   * ───────────────────────────────────────────── */

  /**
   * Initialize Firestore connection.
   * Must be called after Firebase is initialized.
   *
   * @param {Object} [options]
   *   offlinePersistence  – enable Firestore offline cache (default false)
   *   collectionPrefix    – string prefix for all collection names
   * @returns {Promise<void>}
   */
  async function init(options) {
    options = options || {};

    if (typeof firebase === "undefined" || !firebase.firestore) {
      _err("Firebase Firestore SDK not available");
      return;
    }

    _ctx.db = firebase.firestore();
    _ctx.prefix = options.collectionPrefix || "";
    _ctx.offline = !!options.offlinePersistence;

    if (_ctx.offline) {
      try {
        await _ctx.db.enablePersistence({ synchronizeTabs: true });
        _log("offline persistence enabled");
      } catch (e) {
        if (e.code === "failed-precondition") {
          _log("offline persistence skipped — multiple tabs open");
        } else if (e.code === "unimplemented") {
          _log("offline persistence not supported in this browser");
        } else {
          _err("enablePersistence error", e);
        }
      }
    }

    _ctx.initialized = true;
    _log('initialized (prefix="' + _ctx.prefix + '")');
  }

  /**
   * Listen to /system/status in real-time.
   * When maintenance.enabled === true:
   *   – updates VisionConfig maintenance state
   *   – shows VisionOverlays.showMaintenance() for non-admins
   * When disabled:
   *   – hides the maintenance overlay
   */
  function syncSystemStatus() {
    if (!_assertInit("syncSystemStatus")) return;

    try {
      const ref = _ctx.db.collection("system").doc("status");
      const unsub = ref.onSnapshot(
        (doc) => {
          if (!doc.exists) return;
          const data = doc.data();

          // Update system status in config
          if (window.VisionConfig) {
            window.VisionConfig.merge("system", {
              status: data.status || "operational",
              message: data.message || "",
              lastUpdated: Date.now(),
            });
          }

          const maint = data.maintenance || {};
          _log("syncSystemStatus received: maintenance.enabled=" + maint.enabled);

          if (maint.enabled) {
            const startTime = maint.startTime
              ? _toDate(maint.startTime).toISOString()
              : null;
            const endTime = maint.endTime
              ? _toDate(maint.endTime).toISOString()
              : null;

            if (window.VisionConfig) {
              window.VisionConfig.merge("maintenance", {
                enabled: true,
                startTime,
                endTime,
                message: maint.message || "",
                bypassAllowed: maint.bypassAllowed !== false,
              });
            }

            // Show overlay for non-admins
            const isAdmin = window.VisionAuth && window.VisionAuth.isAdmin();
            if (!isAdmin && window.VisionOverlays) {
              window.VisionOverlays.showMaintenance({
                title: maint.title || "النظام تحت الصيانة",
                message: maint.message || "نعمل على تحسين النظام",
                endTime,
                adminBypass: maint.bypassAllowed !== false,
                onAdminBypass: async () => {
                  if (!window.VisionAuth) return;
                  const ok = await window.VisionAuth.promptAdminLogin();
                  if (ok && window.VisionOverlays)
                    window.VisionOverlays.hideMaintenance();
                },
              });
            }
          } else {
            // Maintenance ended
            if (window.VisionConfig)
              window.VisionConfig.set("maintenance.enabled", false);
            if (window.VisionOverlays) window.VisionOverlays.hideMaintenance();
          }
        },
        (error) => _handleError(error, "syncSystemStatus"),
      );

      _unsubs["systemStatus"] = unsub;
    } catch (e) {
      _handleError(e, "syncSystemStatus setup");
    }
  }

  /**
   * Listen to active broadcast notifications in Firestore.
   * New documents are pushed to VisionConfig and shown as toasts.
   *
   * @param {Object} [options]
   *   limit     – max documents to load (default 20)
   *   showToast – whether to show a toast per notification (default true)
   */
  function syncNotifications(options) {
    if (!_assertInit("syncNotifications")) return;
    options = options || {};
    const limit = options.limit !== undefined ? options.limit : 20;
    const showToast =
      options.showToast !== undefined ? options.showToast : true;

    const seenIds = new Set();

    try {
      const query = _ctx.db
        .collection(_col("notifications"))
        .where("active", "==", true)
        .orderBy("createdAt", "desc")
        .limit(limit);

      const unsub = query.onSnapshot(
        (snapshot) => {
          snapshot.docChanges().forEach((change) => {
            const docId = change.doc.id;

            if (change.type === "added" && !seenIds.has(docId)) {
              seenIds.add(docId);
              const raw = change.doc.data();

              let notif = {
                id: docId,
                type: raw.type || "info",
                title: raw.title || "",
                message: raw.message || "",
                severity: raw.severity || "low",
                persistent: !!raw.persistent,
                position: raw.position || "top-left",
                timestamp: raw.createdAt
                  ? _toDate(raw.createdAt).getTime()
                  : Date.now(),
              };

              // Validate & sanitize
              if (window.VisionSecurity) {
                const result =
                  window.VisionSecurity.validateNotification(notif);
                if (result.sanitized)
                  notif = Object.assign(notif, result.sanitized);
              }

              if (window.VisionConfig)
                window.VisionConfig.addNotification(notif);

              if (showToast && window.VisionOverlays) {
                window.VisionOverlays.toast({
                  id: notif.id,
                  type: notif.type,
                  title: notif.title,
                  message: notif.message,
                  duration: notif.persistent ? 0 : undefined,
                  position: notif.position,
                });
              }
            }

            if (change.type === "removed") {
              seenIds.delete(docId);
              if (window.VisionConfig)
                window.VisionConfig.removeNotification(docId);
              if (window.VisionOverlays)
                window.VisionOverlays.dismissToast(docId);
            }
          });
        },
        (error) => _handleError(error, "syncNotifications"),
      );

      _unsubs["notifications"] = unsub;
    } catch (e) {
      _handleError(e, "syncNotifications setup");
    }
  }

  /**
   * Listen to /subscriptions/{userId} in real-time.
   * Updates VisionConfig and triggers expiry warnings.
   *
   * @param {string} userId
   */
  function syncSubscription(userId) {
    if (!_assertInit("syncSubscription") || !userId) return;

    const key = "subscription_" + userId;
    if (_unsubs[key]) {
      _unsubs[key]();
      delete _unsubs[key];
    } // reset if already watching

    try {
      const ref = _ctx.db.collection("subscriptions").doc(userId);
      const unsub = ref.onSnapshot(
        (doc) => {
          if (!doc.exists) return;
          const data = doc.data();
          const expiryDate = data.expiryDate ? _toDate(data.expiryDate) : null;
          const now = new Date();
          const isActive =
            data.isActive !== false && (!expiryDate || expiryDate > now);
          const daysRemaining = expiryDate
            ? Math.ceil((expiryDate.getTime() - now.getTime()) / 86_400_000)
            : null;

          const sub = {
            tier: data.tier || "free",
            expiryDate: expiryDate ? expiryDate.toISOString() : null,
            features: data.features || [],
            isActive,
            userId,
            daysRemaining,
          };

          if (window.VisionConfig)
            window.VisionConfig.merge("subscription", sub);
          if (window.VisionNotifications)
            window.VisionNotifications.subscriptionStatus(sub);
        },
        (error) => _err("syncSubscription error for " + userId, error),
      );

      _unsubs[key] = unsub;
    } catch (e) {
      _err("syncSubscription setup error", e);
    }
  }

  /* ─────────────────────────────────────────────
   * ADMIN WRITE METHODS
   * ───────────────────────────────────────────── */

  /**
   * Push a notification document to Firestore.
   * @param {Object} notification
   * @returns {Promise<string>} document id
   */
  async function sendNotification(notification) {
    _assertInit("sendNotification", true);
    const data = Object.assign(
      {
        type: "info",
        title: "",
        message: "",
        severity: "low",
        active: true,
        persistent: false,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      },
      notification,
    );

    const ref = await _ctx.db.collection(_col("notifications")).add(data);
    return ref.id;
  }

  /**
   * Update the /system/status document.
   * @param {Object} status  – merged with existing document
   * @returns {Promise<void>}
   */
  async function updateSystemStatus(status) {
    _assertInit("updateSystemStatus", true);
    await _ctx.db
      .collection("system")
      .doc("status")
      .set(
        Object.assign(
          { updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
          status,
        ),
        { merge: true },
      );
  }

  /**
   * Toggle maintenance mode with proper Firestore Timestamps.
   * Now ensures the document exists and forces UI update.
   *
   * @param {Object} data
   *   enabled       – boolean
   *   title         – string
   *   message       – string
   *   startTime     – ISO string or Date (null = now)
   *   endTime       – ISO string or Date or null
   *   bypassAllowed – boolean (default true)
   * @returns {Promise<void>}
   */
  async function setMaintenanceMode(data) {
    _assertInit("setMaintenanceMode", true);
    data = data || {};

    const toTimestamp = (v) =>
      v ? firebase.firestore.Timestamp.fromDate(new Date(v)) : null;

    const maintenance = {
      enabled: !!data.enabled,
      title: data.title || "النظام تحت الصيانة",
      message: data.message || "نعمل على تحسين النظام",
      bypassAllowed: data.bypassAllowed !== false,
      startTime: toTimestamp(data.startTime),
      endTime: toTimestamp(data.endTime),
    };

    const payload = {
      status: data.enabled ? "maintenance" : "operational",
      maintenance,
    };

    _log("setMaintenanceMode: " + JSON.stringify({ enabled: data.enabled }));

    // 1. Ensure the document exists first (create if needed)
    const docRef = _ctx.db.collection("system").doc("status");
    await docRef.set(
      { updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    _log("document ensured");

    // 2. Now write the maintenance data
    await updateSystemStatus(payload);
    _log("maintenance data written");

    // 3. Force UI update immediately (don't wait for listener)
    if (window.VisionConfig) {
      window.VisionConfig.merge("maintenance", {
        enabled: maintenance.enabled,
        startTime: maintenance.startTime ? new Date(maintenance.startTime).toISOString() : null,
        endTime: maintenance.endTime ? new Date(maintenance.endTime).toISOString() : null,
        message: maintenance.message,
        bypassAllowed: maintenance.bypassAllowed,
      });
      _log("VisionConfig updated immediately");
    }

    // 4. Show/hide overlay immediately (respecting admin bypass)
    if (data.enabled) {
      const isAdmin = window.VisionAuth && window.VisionAuth.isAdmin();
      if (!isAdmin && window.VisionOverlays) {
        _log("showing maintenance overlay (not admin)");
        window.VisionOverlays.showMaintenance({
          title: maintenance.title,
          message: maintenance.message,
          endTime: maintenance.endTime ? new Date(maintenance.endTime).toISOString() : null,
          adminBypass: maintenance.bypassAllowed,
        });
      } else if (isAdmin) {
        _log("maintenance mode active but user is admin — overlay skipped");
      }
    } else {
      // Disable maintenance
      if (window.VisionOverlays) {
        _log("hiding maintenance overlay");
        window.VisionOverlays.hideMaintenance();
      }
    }
  }

  /**
   * Unsubscribe all active Firestore listeners.
   */
  function disconnect() {
    Object.keys(_unsubs).forEach((key) => {
      try {
        if (typeof _unsubs[key] === "function") _unsubs[key]();
      } catch (e) {
        _err('disconnect: error unsubscribing "' + key + '"', e);
      }
      delete _unsubs[key];
    });
    _log("all listeners disconnected");
  }

  /**
   * DEBUG HELPER — Get current maintenance status for troubleshooting.
   * @returns {Object} Status info
   */
  function getMaintenanceStatus() {
    const config = window.VisionConfig ? window.VisionConfig.get() : null;
    const maintenance = config ? config.maintenance : null;
    const auth = window.VisionAuth;
    const isAdmin = auth ? auth.isAdmin() : null;
    
    return {
      initialized: _ctx.initialized,
      dbConnected: !!_ctx.db,
      maintenance: maintenance,
      isCurrentlyActive: window.VisionConfig ? window.VisionConfig.isMaintenanceMode() : null,
      userIsAdmin: isAdmin,
      listeners: Object.keys(_unsubs),
      timestamp: new Date().toISOString(),
    };
  }

  /* ─────────────────────────────────────────────
   * GUARD HELPER
   * ───────────────────────────────────────────── */
  function _assertInit(fn, throws) {
    if (!_ctx.initialized || !_ctx.db) {
      const msg = fn + ": VisionFirebase not initialized. Call init() first.";
      if (throws) throw new Error("[VisionFirebase] " + msg);
      console.warn("[VisionFirebase] " + msg);
      return false;
    }
    return true;
  }

  /* ─────────────────────────────────────────────
   * EXPORT
   * ───────────────────────────────────────────── */
  window.VisionFirebase = {
    init,
    syncSystemStatus,
    syncNotifications,
    syncSubscription,
    sendNotification,
    updateSystemStatus,
    setMaintenanceMode,
    getMaintenanceStatus,  // ← DEBUG HELPER
    disconnect,
  };

  console.info("[VisionFirebase] ready");
})(window);
