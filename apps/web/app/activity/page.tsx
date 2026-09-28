import { Suspense } from "react";
import { AppSidebar } from "../../components/app-sidebar";
import { ActivityFeed } from "../../components/activity-feed";
import { GitHubNameplate } from "../../components/github-nameplate";
import { resolveGlobalWorkspace } from "../../lib/workflow-runtime";

// `searchParams` (the active drive `?w`) is a dynamic input + a DB read. Reading it
// inside a Suspense boundary lets the static app shell prerender instead of the
// whole route blocking on it (cacheComponents "blocking-route"). Mirrors page.tsx.
export default function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>;
}) {
  return (
    <Suspense fallback={<ActivityShell />}>
      <ActivitySurface searchParams={searchParams} />
    </Suspense>
  );
}

function ActivityShell() {
  return (
    <div className="app-shell">
      <AppSidebar active="activity" />
      <main className="main product-main" aria-busy="true" />
    </div>
  );
}

async function ActivitySurface({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  const { w } = await searchParams;
  const workspace = await resolveGlobalWorkspace(w);
  return (
    <div className="app-shell">
      <AppSidebar active="activity" basePath={workspace.basePath} activeStorageId={workspace.activeStorageId} />
      <main className="main product-main">
        <div className="section-heading library-heading">
          <div>
            <h1>活动</h1>
            <p>点了获取之后，资源在这里逐个被处理 —— 看得见 agent 正在干什么</p>
          </div>
        </div>
        {/* ActivityFeed is a client component in the page's STATIC shell (not inside a
            Suspense'd async server component — those don't hydrate, which froze the
            live poll). It self-fetches /api/activity on mount and polls. */}
        <ActivityFeed storageId={workspace.activeStorageId} />
        <GitHubNameplate />
      </main>
    </div>
  );
}
