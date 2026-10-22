import { describe, expect, it } from "vitest";
import { clipboardIntent } from "./smartArrange";

describe("clipboard intention", () => {
  it("keeps native input paste even when AI is ready or a request is busy", () => {
    for (const available of [false, true]) for (const busy of [false, true]) {
      expect(clipboardIntent({ editable: true, available, busy })).toBe("native");
    }
  });
  it("only adds attachments when unavailable and blocks overlapping work", () => {
    expect(clipboardIntent({ editable: false, available: false, busy: false })).toBe("attachment");
    expect(clipboardIntent({ editable: false, available: true, busy: false })).toBe("arrange");
    for (const available of [false, true]) expect(clipboardIntent({ editable: false, available, busy: true })).toBe("ignore");
  });
});
