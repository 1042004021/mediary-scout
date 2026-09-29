import { connection } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import { resolveCurrentIsOwner } from "../../../../lib/settings-attention-server";
import { getUpdaterStatus } from "../../../../lib/updater-client";

/** Polled by the settings tab while an update is in progress. Owner only; hidden on the demo. */
export async function GET() {
  await connection();
  if (isDemoMode() || !(await resolveCurrentIsOwner())) return new Response(null, { status: 404 });
  return Response.json({ updater: await getUpdaterStatus() });
}
