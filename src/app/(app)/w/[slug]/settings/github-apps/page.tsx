"use client";
import { Topbar } from "@/components/topbar";
import { GithubAppsManager } from "@/components/settings/github-apps";

export default function GithubAppsPage() {
  return (
    <>
      <Topbar
        title="GitHub Apps"
        subtitle="Realtime issue and PR sync plus short-lived runtime git credentials."
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 p-4 sm:p-6">
          <GithubAppsManager />
        </div>
      </div>
    </>
  );
}
