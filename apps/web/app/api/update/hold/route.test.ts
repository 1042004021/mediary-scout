import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn(async () => undefined) };
});

const isUpdaterToken = vi.fn();
vi.mock("../../../../lib/updater-client", () => ({
  isUpdaterToken: (...args: unknown[]) => isUpdaterToken(...args),
}));

import { clearUpdateHold, isUpdateHoldActive, setUpdateHold } from "../../../../lib/update-hold";
import { POST } from "./route";

function post(body: string, token = true) {
  return new Request("http://localhost/api/update/hold", {
    method: "POST",
    headers: token ? { authorization: "Bearer t", "content-type": "application/json" } : {},
    body,
  });
}

describe("POST /api/update/hold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isUpdaterToken.mockResolvedValue(true);
  });
  afterEach(() => clearUpdateHold());

  it("is 401 without the updater token and leaves the hold alone", async () => {
    isUpdaterToken.mockResolvedValue(false);
    const response = await POST(post('{"hold":true}', false));
    expect(response.status).toBe(401);
    expect(isUpdateHoldActive(Date.now())).toBe(false);
  });

  it("takes the hold", async () => {
    const response = await POST(post('{"hold":true}'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hold: true });
    expect(isUpdateHoldActive(Date.now())).toBe(true);
  });

  it("releases the hold", async () => {
    setUpdateHold(Date.now());
    const response = await POST(post('{"hold":false}'));
    expect(response.status).toBe(200);
    expect(isUpdateHoldActive(Date.now())).toBe(false);
  });

  it("is 400 on a body that is not {hold: boolean}", async () => {
    for (const body of ["", "not json", '{"hold":"yes"}', "{}"]) {
      const response = await POST(post(body));
      expect(response.status).toBe(400);
    }
    expect(isUpdateHoldActive(Date.now())).toBe(false);
  });
});
