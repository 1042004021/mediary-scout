import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn(async () => undefined) };
});

const isUpdaterToken = vi.fn();
vi.mock("../../../../lib/updater-client", () => ({
  isUpdaterToken: (...args: unknown[]) => isUpdaterToken(...args),
}));

const hasActiveWorkflowRuns = vi.fn();
vi.mock("../../../../lib/has-active-workflow-runs", () => ({
  hasActiveWorkflowRuns: (...args: unknown[]) => hasActiveWorkflowRuns(...args),
}));

const repository = { id: "repo" };
vi.mock("../../../../lib/workflow-runtime", () => ({
  getWorkflowRepository: () => repository,
}));

import { clearUpdateHold, setUpdateHold, whileInFlight } from "../../../../lib/update-hold";
import { GET } from "./route";

describe("GET /api/update/busy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is 401 without the updater token and does not look at runs", async () => {
    isUpdaterToken.mockResolvedValue(false);
    const response = await GET(new Request("http://localhost/api/update/busy"));
    expect(response.status).toBe(401);
    expect(hasActiveWorkflowRuns).not.toHaveBeenCalled();
  });

  it("reports busy from every account, not the default account alone", async () => {
    isUpdaterToken.mockResolvedValue(true);
    hasActiveWorkflowRuns.mockResolvedValue(true);
    const response = await GET(new Request("http://localhost/api/update/busy", { headers: { authorization: "Bearer t" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ busy: true });
    expect(hasActiveWorkflowRuns).toHaveBeenCalledWith(repository, { holdStartedAt: null, now: expect.any(Number) });
  });

  it("is busy while a worker tick or patrol is in flight, without asking the database", async () => {
    isUpdaterToken.mockResolvedValue(true);
    hasActiveWorkflowRuns.mockResolvedValue(false);
    let release!: () => void;
    const pending = whileInFlight(() => new Promise<void>((resolve) => (release = resolve)));
    try {
      const response = await GET(new Request("http://localhost/api/update/busy", { headers: { authorization: "Bearer t" } }));
      expect(await response.json()).toEqual({ busy: true });
      expect(hasActiveWorkflowRuns).not.toHaveBeenCalled();
    } finally {
      release();
      await pending;
    }
  });

  it("passes the hold's start time once the updater has taken it", async () => {
    isUpdaterToken.mockResolvedValue(true);
    hasActiveWorkflowRuns.mockResolvedValue(false);
    const takenAt = Date.now() - 20_000;
    setUpdateHold(takenAt, 60_000);
    try {
      const response = await GET(new Request("http://localhost/api/update/busy", { headers: { authorization: "Bearer t" } }));
      expect(await response.json()).toEqual({ busy: false });
      expect(hasActiveWorkflowRuns).toHaveBeenCalledWith(repository, { holdStartedAt: takenAt, now: expect.any(Number) });
    } finally {
      clearUpdateHold();
    }
  });
});
