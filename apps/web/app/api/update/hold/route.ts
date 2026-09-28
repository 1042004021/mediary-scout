import { connection } from "next/server";
import { clearUpdateHold, setUpdateHold } from "../../../../lib/update-hold";
import { isUpdaterToken } from "../../../../lib/updater-client";

/** Called by the updater right before it swaps the web container: `{"hold": true}` stops
 *  new runs from starting (queued ones wait for the new version); `{"hold": false}`
 *  releases it when the update stops before the swap. */
export async function POST(request: Request) {
  await connection();
  if (!(await isUpdaterToken(request.headers.get("authorization")))) {
    return new Response(null, { status: 401 });
  }
  let hold: unknown = null;
  try {
    hold = ((await request.json()) as { hold?: unknown }).hold;
  } catch {
    hold = null;
  }
  if (hold === true) {
    setUpdateHold(Date.now());
    return Response.json({ hold: true });
  }
  if (hold === false) {
    clearUpdateHold();
    return Response.json({ hold: false });
  }
  return new Response(null, { status: 400 });
}
