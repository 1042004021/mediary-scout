import { connection } from "next/server";
import { hasActiveWorkflowRuns } from "../../../../lib/has-active-workflow-runs";
import { isUpdaterToken } from "../../../../lib/updater-client";
import { getWorkflowRepository } from "../../../../lib/workflow-runtime";

/** Asked by the updater before it swaps: is any account's run still queued or running? */
export async function GET(request: Request) {
  await connection();
  if (!(await isUpdaterToken(request.headers.get("authorization")))) {
    return new Response(null, { status: 401 });
  }
  const busy = await hasActiveWorkflowRuns(getWorkflowRepository());
  return Response.json({ busy });
}
