import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const importForeignWorkFiles = vi.fn();
const isUpdateInProgress = vi.fn(() => false);
vi.mock("../lib/workflow-runtime", () => ({
  importForeignWorkFiles: (...args: unknown[]) => importForeignWorkFiles(...args),
  isUpdateInProgress: () => isUpdateInProgress(),
}));

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
