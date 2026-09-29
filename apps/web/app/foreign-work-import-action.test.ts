import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const importForeignWorkFiles = vi.fn();
const isUpdateInProgress = vi.fn(() => false);
vi.mock("../lib/workflow-runtime", () => {
  // Declared inside the factory: vi.mock is hoisted above module-level declarations.
  class UpdateInProgressError extends Error {
    constructor(message = "正在更新，更新完成后再试。") {
      super(message);
      this.name = "UpdateInProgressError";
    }
  }
  return {
    importForeignWorkFiles: (...args: unknown[]) => importForeignWorkFiles(...args),
    isUpdateInProgress: () => isUpdateInProgress(),
    UpdateInProgressError,
  };
});
const { UpdateInProgressError } = await import("../lib/workflow-runtime");

import { importForeignWorkAction } from "./actions";

const INPUT = { providerFileIds: ["1", "2"], movieTitle: "沙丘", year: 2021 };

const prevDemo = process.env.MEDIA_TRACK_DEMO_MODE;
afterEach(() => {
  vi.clearAllMocks();
  isUpdateInProgress.mockReturnValue(false);
  if (prevDemo === undefined) delete process.env.MEDIA_TRACK_DEMO_MODE;
  else process.env.MEDIA_TRACK_DEMO_MODE = prevDemo;
});

describe("importForeignWorkAction", () => {
  it("refuses under the update hold and never touches the drive", async () => {
    delete process.env.MEDIA_TRACK_DEMO_MODE;
    isUpdateInProgress.mockReturnValue(true);
    expect(await importForeignWorkAction(INPUT)).toEqual({
      status: "failed",
      message: "正在更新，更新完成后再入库。",
    });
    expect(importForeignWorkFiles).not.toHaveBeenCalled();
  });

  it("maps the in-flight hold recheck (UpdateInProgressError) to the update message, not 入库失败", async () => {
    // The upfront check passed, but the updater took the hold in the gap and the helper's
    // in-flight recheck threw. The user must see "try again after the update", not a raw error.
    delete process.env.MEDIA_TRACK_DEMO_MODE;
    importForeignWorkFiles.mockRejectedValue(new UpdateInProgressError());
    expect(await importForeignWorkAction(INPUT)).toEqual({
      status: "failed",
      message: "正在更新，更新完成后再入库。",
    });
  });

  it("imports normally when no update is holding", async () => {
    delete process.env.MEDIA_TRACK_DEMO_MODE;
    importForeignWorkFiles.mockResolvedValue({ movieDirectoryId: "d1", movedFileIds: ["1", "2"] });
    expect(await importForeignWorkAction(INPUT)).toEqual({
      status: "imported",
      message: "已入库到 沙丘 (2021)。",
    });
    expect(importForeignWorkFiles).toHaveBeenCalledWith({
      providerFileIds: ["1", "2"],
      movieTitle: "沙丘",
      year: 2021,
    });
  });
});
