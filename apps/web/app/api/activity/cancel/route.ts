import { isDemoMode } from "../../../../lib/demo-mode";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentAccountId, getWorkflowRepository } from "../../../../lib/workflow-runtime";

/**
 * Cancel a still-QUEUED run (user action from the activity page). An acquisition goes
 * with the tracking it created, so the title also leaves the library. A replace_request
 * (a user's message) only drops this attempt: the library stays, and its messages go
 * back to waiting for the next patrol (not urgent, so the queue does not pick them right
 * back up). Returns { status: "cancelled" | "not_cancellable" } — not_cancellable when
 * the worker already claimed it (the UI then refreshes to show it running).
 */
export async function POST(request: NextRequest) {
  if (isDemoMode()) return Response.json({ error: "演示站只读" }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { runId?: unknown };
  const runId = typeof body.runId === "string" ? body.runId : null;
  if (!runId) {
    return NextResponse.json({ error: "runId required" }, { status: 400 });
  }
  const result = await getWorkflowRepository().cancelQueuedWorkflowRun(runId, await getCurrentAccountId());
  return NextResponse.json(result);
}
