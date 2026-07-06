/**
 * vision-init.js — System Bootstrap
 * ====================================
 * This is the ONLY file referenced by the HTML pages.
 * It is responsible for:
 *
 *   1. Defining the Firebase project configuration (edit the FIREBASE_CONFIG
 *      block below with your actual project values).
 *   2. Initializing the Firebase SDK (idempotent: skips if already done).
 *   3. Dynamically loading the five Vision module files in dependency order.
 *   4. Fetching client configuration from Firestore (/system/config).
 *   5. Exposing window.CLIENT_BRAND, window.ALLOWED_EMAILS, window.CLIENT_DATA.
 *   6. Starting Firestore real-time listeners (system status, notifications).
 *   7. Dispatching the 'vision-ready' CustomEvent on window.
 *
 * Firestore document: /system/config
 * ─────────────────────────────────────
 *   {
 *     brandName:     "اسم الشركة",       // → window.CLIENT_BRAND
 *     allowedEmails: ["a@b.com", …],     // → window.ALLOWED_EMAILS
 *     settings:      { … }               // → window.CLIENT_DATA.settings
 *   }
 *
 * Place all six vision-*.js files in the same directory as this file.
 * They are loaded dynamically in the correct dependency order.
 */
(function (window, document) {
  "use strict";

  /* ══════════════════════════════════════════════
   * ▶ EDIT THIS BLOCK WITH YOUR FIREBASE PROJECT
   * ══════════════════════════════════════════════ */
  var FIREBASE_CONFIG = {
    apiKey: "AIzaSyCfqb7u3Es7rq39E4Mb8cRJM487odXVJa0",
    authDomain: "erp-website-38fe1.firebaseapp.com",
    projectId: "erp-website-38fe1",
    storageBucket: "erp-website-38fe1.firebasestorage.app",
    messagingSenderId: "74025192730",
    appId: "1:74025192730:web:392eb58f3d59a33e66f0a3",
    // measurementId: "G-NBW3S78ZLJ"
  };
  // Initialize Firebase
  // const app = initializeApp(firebaseConfig);
  // const analytics = getAnalytics(app);
  /* ══════════════════════════════════════════════ */

  /* ─────────────────────────────────────────────
   * SIMPLE LOGGER
   * ───────────────────────────────────────────── */
  function log(msg) {
    console.log("[VisionInit] " + msg);
  }
  function warn(msg) {
    console.warn("[VisionInit] " + msg);
  }
  function err(msg, e) {
    console.error("[VisionInit] " + msg, e || "");
  }

  /* ─────────────────────────────────────────────
   * RESOLVE THE BASE URL FOR LOADING MODULES
   * Handles being embedded in a sub-folder.
   * ───────────────────────────────────────────── */
  var _baseUrl = (function () {
    var scripts = document.querySelectorAll("script[src]");
    var selfSrc = "";
    for (var i = scripts.length - 1; i >= 0; i--) {
      if (scripts[i].src && scripts[i].src.indexOf("vision-init") !== -1) {
        selfSrc = scripts[i].src;
        break;
      }
    }
    if (!selfSrc) return "";
    return selfSrc.substring(0, selfSrc.lastIndexOf("/") + 1);
  })();

  /* ─────────────────────────────────────────────
   * SCRIPT LOADER
   * ───────────────────────────────────────────── */
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      // Skip if already present in the DOM
      if (document.querySelector('script[src="' + src + '"]')) {
        return resolve();
      }
      var s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = function () {
        reject(new Error("Failed to load: " + src));
      };
      document.head.appendChild(s);
    });
  }

  /** Load Vision modules in dependency order */
  function loadModules() {
    var modules = [
      "vision-config.js", // no deps
      "vision-security.js", // no deps
      "vision-overlays.js", // needs VisionSecurity, VisionConfig
      "vision-notifications.js", // needs VisionConfig, VisionOverlays
      "vision-auth.js", // needs VisionConfig, VisionOverlays
      "vision-firebase.js", // needs all above
      "vision-licensing.js", // needs VisionFirebase, VisionConfig, VisionAuth
    ];

    // Chain loads sequentially so each module finds the previous ones on window
    return modules.reduce(function (chain, name) {
      return chain.then(function () {
        return loadScript(_baseUrl + name);
      });
    }, Promise.resolve());
  }

  /* ─────────────────────────────────────────────
   * DOM READY
   * ───────────────────────────────────────────── */
  function domReady() {
    return new Promise(function (resolve) {
      if (document.readyState !== "loading") return resolve();
      document.addEventListener("DOMContentLoaded", resolve, { once: true });
    });
  }

  /* ─────────────────────────────────────────────
   * FIRE THE vision-ready EVENT
   * ───────────────────────────────────────────── */
  function fireReady() {
    var event = new CustomEvent("vision-ready", {
      bubbles: true,
      detail: {
        brand: window.CLIENT_BRAND,
        allowedEmails: window.ALLOWED_EMAILS,
        data: window.CLIENT_DATA,
      },
    });
    window.dispatchEvent(event);
    log(
      'vision-ready dispatched — brand="' + (window.CLIENT_BRAND || "") + '"',
    );
  }

  /* ─────────────────────────────────────────────
   * APPLY CONFIG FROM FIRESTORE DOCUMENT
   * ───────────────────────────────────────────── */
  function applyConfig(config) {
    window.CLIENT_BRAND = config.brandName || config.brand || "نظام الإدارة";
    window.ALLOWED_EMAILS = Array.isArray(config.allowedEmails)
      ? config.allowedEmails
      : [];
    window.CLIENT_DATA = config;

    if (window.VisionConfig) {
      window.VisionConfig.set("settings", config.settings || {});
    }

    log(
      'config applied — brand="' +
        window.CLIENT_BRAND +
        '"' +
        ", allowedEmails=" +
        window.ALLOWED_EMAILS.length,
    );
  }

  function applyDefaults() {
    window.CLIENT_BRAND = window.CLIENT_BRAND || "نظام الإدارة";
    window.ALLOWED_EMAILS = window.ALLOWED_EMAILS || [];
    window.CLIENT_DATA = window.CLIENT_DATA || {};
  }

  /* ─────────────────────────────────────────────
   * FETCH /system/config FROM FIRESTORE
   * ───────────────────────────────────────────── */
  async function fetchConfig() {
    if (typeof firebase === "undefined" || !firebase.firestore) {
      warn("Firestore not available — using defaults");
      applyDefaults();
      return;
    }
    try {
      var db = firebase.firestore();
      var doc = await db.collection("system").doc("config").get();
      if (doc.exists) {
        applyConfig(doc.data());
      } else {
        warn("/system/config not found — using defaults");
        applyDefaults();
      }
    } catch (e) {
      err("fetchConfig failed", e);
      applyDefaults();
    }
  }

  /* ─────────────────────────────────────────────
   * INITIALIZE FIREBASE (IDEMPOTENT)
   * ───────────────────────────────────────────── */
  function initFirebase() {
    if (typeof firebase === "undefined") {
      warn(
        "Firebase SDK not found. Ensure the firebase-app-compat CDN is loaded first.",
      );
      return;
    }
    if (!firebase.apps || firebase.apps.length === 0) {
      firebase.initializeApp(FIREBASE_CONFIG);
      log("Firebase initialized");
    } else {
      log("Firebase already initialized — reusing existing app");
    }
  }

  /* ─────────────────────────────────────────────
   * INITIALIZE VISION MODULES
   * ───────────────────────────────────────────── */
  function initModules() {
    // VisionAuth — needs Firebase already initialized
    if (window.VisionAuth) {
      window.VisionAuth.init({ firebase: true });
      log("VisionAuth initialized");
    } else {
      warn("VisionAuth not loaded");
    }

    // VisionFirebase — async init (offline persistence attempt)
    if (window.VisionFirebase) {
      window.VisionFirebase.init({ offlinePersistence: true })
        .then(function () {
          log("VisionFirebase initialized");
        })
        .catch(function (e) {
          err("VisionFirebase.init error", e);
        });
    } else {
      warn("VisionFirebase not loaded");
    }

    // VisionLicensing — synchronous init (listener started in startSyncs)
    if (window.VisionLicensing) {
      window.VisionLicensing.init();
      log("VisionLicensing initialized");
    } else {
      warn("VisionLicensing not loaded");
    }
  }

  /* ─────────────────────────────────────────────
   * START REAL-TIME LISTENERS
   * ───────────────────────────────────────────── */
  function startSyncs() {
    if (!window.VisionFirebase) return;

    // System status (maintenance mode, etc.)
    try {
      window.VisionFirebase.syncSystemStatus();
      log("system status sync started");
    } catch (e) {
      err("syncSystemStatus failed", e);
    }

    // Global broadcast notifications
    try {
      window.VisionFirebase.syncNotifications({ limit: 10, showToast: true });
      log("notifications sync started");
    } catch (e) {
      err("syncNotifications failed", e);
    }

    // System licensing sync — real-time listener on system_status/config
    if (window.VisionLicensing) {
      try {
        window.VisionLicensing.startSync();
        log("licensing sync started");
      } catch (e) {
        err("licensing sync failed", e);
      }
    }

    // Per-user subscription sync — starts when a user logs in
    if (window.VisionAuth) {
      window.VisionAuth.onAuthStateChanged(function (user) {
        if (user && user.uid) {
          try {
            window.VisionFirebase.syncSubscription(user.uid);
            log("subscription sync started for " + user.uid);
          } catch (e) {
            err("syncSubscription failed", e);
          }
        }
      });
    }
  }

  /* ─────────────────────────────────────────────
   * CLEANUP ON UNLOAD
   * ───────────────────────────────────────────── */
  window.addEventListener("beforeunload", function () {
    if (window.VisionFirebase) {
      window.VisionFirebase.disconnect();
    }
    if (window.VisionLicensing) {
      window.VisionLicensing.disconnect();
    }
  });

  /* ─────────────────────────────────────────────
   * MAIN BOOTSTRAP SEQUENCE
   * ───────────────────────────────────────────── */
  async function bootstrap() {
    log("bootstrap starting…");

    // 1. Wait for DOM
    await domReady();

    // 2. Initialize Firebase SDK
    initFirebase();

    // 3. Load Vision module files
    try {
      await loadModules();
      log("all modules loaded");
    } catch (e) {
      err("module load failed", e);
      // Carry on — some modules may have loaded; the pages will degrade gracefully
    }

    // 4. Initialize modules that need Firebase
    initModules();

    // 5. Fetch client configuration from Firestore
    await fetchConfig();

    // 6. Start real-time Firestore listeners
    startSyncs();

    // 7. Dispatch vision-ready — pages begin their own init
    fireReady();
  }

  // Kick off and guarantee vision-ready fires even on fatal error
  bootstrap().catch(function (e) {
    err("bootstrap failed", e);
    applyDefaults();
    try {
      fireReady();
    } catch (_) {
      /* already dispatched */
    }
  });
})(window, document);
