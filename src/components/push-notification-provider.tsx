"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

const PUSH_PROMPTED_KEY = "forge.pwa.push.prompted";
const PUSH_IOS_HINT_KEY = "forge.pwa.push.ios-hint";

export function PushNotificationProvider() {
  const promptShownRef = useRef(false);
  const config = trpc.notification.pushConfig.useQuery(undefined, {
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
  const subscribePush = trpc.notification.subscribePush.useMutation();

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!config.data?.enabled || !config.data.publicKey) return;
    if (!supportsBrowserPush()) {
      if (isIOS() && !isStandalone() && readLocalStorage(PUSH_IOS_HINT_KEY) !== "1") {
        writeLocalStorage(PUSH_IOS_HINT_KEY, "1");
        window.setTimeout(() => {
          toast("Push alerts need the installed app on iOS", {
            description: "Add Forge to Home Screen, then open it there to enable alerts.",
            duration: 12_000,
          });
        }, 5000);
      }
      return;
    }

    if (Notification.permission === "granted") {
      void ensurePushSubscription(config.data.publicKey, subscribePush.mutateAsync);
      return;
    }

    if (Notification.permission !== "default") return;
    if (promptShownRef.current || readLocalStorage(PUSH_PROMPTED_KEY) === "1") return;
    promptShownRef.current = true;
    writeLocalStorage(PUSH_PROMPTED_KEY, "1");

    window.setTimeout(() => {
      toast("Enable Forge alerts", {
        description: "Android can notify you when agents need attention.",
        duration: 15_000,
        action: {
          label: "Enable",
          onClick: async () => {
            const permission = await Notification.requestPermission();
            if (permission !== "granted") {
              writeLocalStorage(PUSH_PROMPTED_KEY, "0");
              return;
            }
            await ensurePushSubscription(config.data.publicKey!, subscribePush.mutateAsync);
            toast.success("Forge alerts enabled");
          },
        },
      });
    }, 4500);
  }, [config.data?.enabled, config.data?.publicKey, subscribePush.mutateAsync]);

  return null;
}

async function ensurePushSubscription(
  publicKey: string,
  save: (input: { endpoint: string; keys: { p256dh: string; auth: string } }) => Promise<unknown>,
) {
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));
  const serialized = serializeSubscription(subscription);
  if (!serialized) return;
  await save(serialized);
}

function serializeSubscription(
  subscription: PushSubscription,
): { endpoint: string; keys: { p256dh: string; auth: string } } | null {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) return null;
  return {
    endpoint: json.endpoint,
    keys: { p256dh, auth },
  };
}

function supportsBrowserPush(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return buffer;
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
