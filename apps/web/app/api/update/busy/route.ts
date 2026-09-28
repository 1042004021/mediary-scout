import { connection } from "next/server";
import { hasActiveWorkflowRuns } from "../../../../lib/has-active-workflow-runs";
import { inFlightCount, updateHoldStartedAt } from "../../../../lib/update-hold";
import { isUpdaterToken } from "../../../../lib/updater-client";
import { getWorkflowRepository } from "../../../../lib/workflow-runtime";

/** Asked by the updater before it swaps: is any account's run still queued or running?
 *  While the update hold is on, only running runs count (see hasActiveWorkflowRuns). */
export async function GET(request: Request) {
  await connection();
  if (!(await isUpdaterToken(request.headers.get("authorization")))) {
    return new Response(null, { status: 401 });
  }
  const now = Date.now();
  // A worker tick or patrol still running in this process may be between its hold check
  // and the write it guards: wait for it.
  if (inFlightCount() > 0) return Response.json({ busy: true });
  const busy = await hasActiveWorkflowRuns(getWorkflowRepository(), { holdStartedAt: updateHoldStartedAt(now), now });
  return Response.json({ busy });
}
