"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

const INSTALL_PROMPTED_KEY = "forge.pwa.install.prompted";
const IOS_HINT_KEY = "forge.pwa.install.ios-hint";
const OFFLINE_CACHE_PROMPTED_KEY = "forge.pwa.offline-pages.prompted";
const OFFLINE_CACHE_ENABLED_KEY = "forge.pwa.offline-pages.enabled";

export function PwaProvider() {
  const installPromptRef = useRef<BeforeInstallPromptEvent | null>(null);
  const reloadingRef = useRef(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    if (!window.isSecureContext) return;

    const register = () => {
      void navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .then((registration) => {
          void registration.update();
          watchForServiceWorkerUpdate(registration);
          syncOfflinePageCacheFlag();
          queueOfflinePageCachePrompt();
        })
        .catch(() => {
          // Installability should fail soft; Forge still runs as a normal web app.
        });
    };

    const onControllerChange = () => {
      if (reloadingRef.current) return;
      reloadingRef.current = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
    }

    return () => {
      window.removeEventListener("load", register);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      installPromptRef.current = event as BeforeInstallPromptEvent;
      if (readLocalStorage(INSTALL_PROMPTED_KEY) === "1") return;
      writeLocalStorage(INSTALL_PROMPTED_KEY, "1");
      toast("Install Forge", {
        description: "Android can open Forge from the launcher in standalone mode.",
        duration: 15_000,
        action: {
          label: "Install",
          onClick: () => {
            const promptEvent = installPromptRef.current;
            if (!promptEvent) return;
            installPromptRef.current = null;
            void promptEvent
              .prompt()
              .then(() => promptEvent.userChoice)
              .then((choice) => {
                if (choice.outcome === "dismissed") {
                  writeLocalStorage(INSTALL_PROMPTED_KEY, "0");
                }
              });
          },
        },
      });
    };

    const onAppInstalled = () => {
      installPromptRef.current = null;
      writeLocalStorage(INSTALL_PROMPTED_KEY, "1");
      toast.success("Forge installed");
      queueOfflinePageCachePrompt(1500);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);

    if (isIOS() && !isStandalone() && readLocalStorage(IOS_HINT_KEY) !== "1") {
      writeLocalStorage(IOS_HINT_KEY, "1");
      window.setTimeout(() => {
        toast("Install Forge", {
          description: "On iPhone or iPad, use Share then Add to Home Screen.",
          duration: 12_000,
        });
      }, 3500);
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onOffline = () => {
      toast.warning("Forge is offline", {
        id: "forge-offline",
        description: "Live updates and writes will resume after reconnecting.",
        duration: Infinity,
      });
    };
    const onOnline = () => {
      toast.dismiss("forge-offline");
      toast.success("Forge is back online", { duration: 4000 });
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    if (!navigator.onLine) onOffline();
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  return null;
}

function watchForServiceWorkerUpdate(registration: ServiceWorkerRegistration) {
  const notifyWhenInstalled = (worker: ServiceWorker | null) => {
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      if (worker.state !== "installed") return;
      if (!navigator.serviceWorker.controller) return;
      toast("Forge update ready", {
        description: "Reload to switch to the latest app shell.",
        duration: Infinity,
        action: {
          label: "Reload",
          onClick: () => worker.postMessage({ type: "SKIP_WAITING" }),
        },
      });
    });
  };

  notifyWhenInstalled(registration.waiting);
  registration.addEventListener("updatefound", () => {
    notifyWhenInstalled(registration.installing);
  });
}

function queueOfflinePageCachePrompt(delay = 6500) {
  if (!("serviceWorker" in navigator)) return;
  if (readLocalStorage(OFFLINE_CACHE_ENABLED_KEY) === "1") {
    syncOfflinePageCacheFlag();
    return;
  }
  if (readLocalStorage(OFFLINE_CACHE_PROMPTED_KEY) === "1") return;
  window.setTimeout(() => {
    if (readLocalStorage(OFFLINE_CACHE_ENABLED_KEY) === "1") return;
    writeLocalStorage(OFFLINE_CACHE_PROMPTED_KEY, "1");
    toast("Save visited pages offline", {
      description: "This device can keep a read-only copy of pages you open.",
      duration: 14_000,
      action: {
        label: "Enable",
        onClick: () => {
          writeLocalStorage(OFFLINE_CACHE_ENABLED_KEY, "1");
          syncOfflinePageCacheFlag();
          toast.success("Offline pages enabled");
        },
      },
    });
  }, delay);
}

function syncOfflinePageCacheFlag() {
  if (!("serviceWorker" in navigator)) return;
  const enabled = readLocalStorage(OFFLINE_CACHE_ENABLED_KEY) === "1";
  void navigator.serviceWorker.ready.then((registration) => {
    const target = registration.active ?? navigator.serviceWorker.controller;
    target?.postMessage({ type: "SET_OFFLINE_PAGE_CACHE", enabled });
  });
}

function readLocalStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // localStorage can be unavailable in hardened/private browser modes.
  }
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIOS(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) &&
    !(window as Window & { MSStream?: unknown }).MSStream
  );
}
