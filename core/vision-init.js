// core/vision-init.js — System Bootstrap (Firebase Compat)
// ============================================================
// This file initializes Firebase (using compat SDK), loads vision modules,
// applies configuration, starts real-time listeners, and dispatches 'vision-ready'.
// It exposes window.db and window.auth for backward compatibility with legacy code.

(() => {
  "use strict";

  /* ──────────────────────────────────────────────────────────────
   *  LOGGER
   *  ────────────────────────────────────────────────────────────── */
  const log = (msg) => console.log("[VisionInit] " + msg);
  const warn = (msg) => console.warn("[VisionInit] " + msg);
  const err = (msg, e) => console.error("[VisionInit] " + msg, e || "");

  /* ──────────────────────────────────────────────────────────────
   *  BASE URL FOR DYNAMIC SCRIPT LOADING
   *  ────────────────────────────────────────────────────────────── */
  const _baseUrl = (() => {
    const scripts = document.querySelectorAll('script[src]');
    let selfSrc = "";
    for (let i = scripts.length - 1; i >= 0; i--) {
      if (scripts[i].src && scripts[i].src.includes("vision-init")) {
        selfSrc = scripts[i].src;
        break;
      }
    }
    if (!selfSrc) return "";
    return selfSrc.substring(0, selfSrc.lastIndexOf("/") + 1);
  })();

  /* ──────────────────────────────────────────────────────────────
   *  DYNAMIC SCRIPT LOADER (returns Promise)
   *  ────────────────────────────────────────────────────────────── */
  const loadScript = (src) =>
    new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) {
        return resolve();
      }
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Failed to load: ${src}`));
      document.head.appendChild(s);
    });

  /* ──────────────────────────────────────────────────────────────
   *  FIREBASE CONFIG (EDIT WITH YOUR PROJECT VALUES)
   *  ────────────────────────────────────────────────────────────── */
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyCfqb7u3Es7rq39E4Mb8cRJM487odXVJa0",
    authDomain: "erp-website-38fe1.firebaseapp.com",
    projectId: "erp-website-38fe1",
    storageBucket: "erp-website-38fe1.firebasestorage.app",
    messagingSenderId: "74025192730",
    appId: "1:74025192730:web:392eb58f3d59a33e66f0a3"
  };

  /* ──────────────────────────────────────────────────────────────
   *  STEP 1: INITIALIZE FIREBASE IMMEDIATELY (SYNCHRONOUSLY)
   *  This ensures window.db and window.auth are available ASAP for legacy code
   *  ────────────────────────────────────────────────────────────── */
  let dbInstance = null;
  let authInstance = null;

  try {
    // Initialize Firebase app if not already done
    if (typeof firebase !== "undefined") {
      if (!firebase.apps || firebase.apps.length === 0) {
        firebase.initializeApp(FIREBASE_CONFIG);
        log("Firebase initialized with compat SDK");
      } else {
        log("Firebase already initialized — reusing existing app");
      }

      // Get fresh instances and expose globally for backward compatibility
      dbInstance = firebase.firestore();
      authInstance = firebase.auth();
      window.db = dbInstance;
      window.auth = authInstance;
      log("Firestore and Auth exposed to window");
    } else {
      warn("Firebase SDK not found - legacy Firebase code will fail");
      window.db = null;
      window.auth = null;
    }
  } catch (e) {
    err("Firebase initialization failed", e);
    window.db = null;
    window.auth = null;
  }

  /* ──────────────────────────────────────────────────────────────
   *  LOAD VISION MODULES IN DEPENDENCY ORDER
   *  ────────────────────────────────────────────────────────────── */
  function loadModules() {
    const modules = [
      "vision-config.js", // no deps
      "vision-security.js", // no deps
      "vision-overlays.js", // needs VisionSecurity, VisionConfig
      "vision-notifications.js", // needs VisionConfig, VisionOverlays
      "vision-auth.js", // needs VisionConfig, VisionOverlays
      "vision-firebase.js", // needs all above
    ];

    // Chain loads sequentially so each module finds the previous ones on window
    return modules.reduce((chain, name) => chain.then(() => loadScript(_baseUrl + name)), Promise.resolve());
  }

  /* ──────────────────────────────────────────────────────────────
   *  DOM READY
   *  ────────────────────────────────────────────────────────────── */
  function domReady() {
    return new Promise(resolve => {
      if (document.readyState !== "loading") return resolve();
      document.addEventListener("DOMContentLoaded", resolve, { once: true });
    });
  }

  /* ──────────────────────────────────────────────────────────────
   *  FIRE THE vision-ready EVENT
   *  ────────────────────────────────────────────────────────────── */
  function fireReady() {
    const event = new CustomEvent("vision-ready", {
      bubbles: true,
      detail: {
        brand: window.CLIENT_BRAND,
        allowedEmails: window.ALLOWED_EMAILS,
        data: window.CLIENT_DATA
      }
    });
    window.dispatchEvent(event);
    log(`vision-ready dispatched — brand="${window.CLIENT_BRAND || ""}"`);
  }

  /* ──────────────────────────────────────────────────────────────
   *  APPLY CONFIG FROM FIRESTORE DOCUMENT
   *  ────────────────────────────────────────────────────────────── */
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
      `config applied — brand="${window.CLIENT_BRAND}"` +
      `, allowedEmails=${window.ALLOWED_EMAILS.length}`
    );
  }

  function applyDefaults() {
    window.CLIENT_BRAND = window.CLIENT_BRAND || "نظام الإدارة";
    window.ALLOWED_EMAILS = window.ALLOWED_EMAILS || [];
    window.CLIENT_DATA = window.CLIENT_DATA || {};
  }

  /* ──────────────────────────────────────────────────────────────
   *  FETCH /system/config FROM FIRESTORE
   *  ────────────────────────────────────────────────────────────── */
  async function fetchConfig() {
    // Check if Firestore is available
    if (typeof firebase === "undefined" || !firebase.firestore || !window.db) {
      warn("Firestore not available — using defaults");
      applyDefaults();
      return;
    }

    try {
      // Use the globally exposed db (set during initialization)
      const db = window.db;
      if (!db) throw new Error("Firestore instance not available");

      const doc = await db.collection("system").doc("config").get();
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

  /* ──────────────────────────────────────────────────────────────
   *  INITIALIZE VISION MODULES
   *  ────────────────────────────────────────────────────────────── */
  function initModules() {
    // VisionAuth — needs Firebase already initialized
    if (window.VisionAuth) {
      try {
        window.VisionAuth.init({ firebase: true });
        log("VisionAuth initialized");
      } catch (e) {
        err("VisionAuth.init failed", e);
      }
    } else {
      warn("VisionAuth not loaded");
    }

    // VisionFirebase — async init (offline persistence attempt)
    if (window.VisionFirebase) {
      window.VisionFirebase
        .init({ offlinePersistence: true })
        .then(() => log("VisionFirebase initialized"))
        .catch(e => err("VisionFirebase.init error", e));
    } else {
      warn("VisionFirebase not loaded");
    }
  }

  /* ──────────────────────────────────────────────────────────────
   *  START REAL-TIME LISTENERS
   *  ────────────────────────────────────────────────────────────── */
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

    // Per-user subscription sync — starts when a user logs in
    if (window.VisionAuth) {
      window.VisionAuth.onAuthStateChanged(user => {
        if (user && user.uid) {
          try {
            window.VisionFirebase.syncSubscription(user.uid);
            log(`subscription sync started for ${user.uid}`);
          } catch (e) {
            err("syncSubscription failed", e);
          }
        }
      });
    }
  }

  /* ──────────────────────────────────────────────────────────────
   *  CLEANUP ON UNLOAD
   *  ────────────────────────────────────────────────────────────── */
  window.addEventListener("beforeunload", () => {
    if (window.VisionFirebase) {
      window.VisionFirebase.disconnect();
    }
  });

  /* ──────────────────────────────────────────────────────────────
   *  MAIN BOOTSTRAP SEQUENCE
   *  ────────────────────────────────────────────────────────────── */
  async function bootstrap() {
    log("bootstrap starting…");

    // 1. Wait for DOM
    await domReady();

    // 2. Firebase already initialized above (synchronous)

    // 3. Load Vision module files
    try {
      await loadModules();
      log("all modules loaded");
    } catch (e) {
      err("module load failed", e);
      // Continue — some modules may have loaded; pages degrade gracefully
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
  bootstrap().catch(e => {
    err("bootstrap failed", e);
    applyDefaults();
    try {
      fireReady();
    } catch (_) {
      /* already dispatched */
    }
  });
})();