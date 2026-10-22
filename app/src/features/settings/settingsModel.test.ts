import { describe, expect, it } from "vitest";
import type { CustomerSetting, QuickDueSetting } from "../../contracts/settings";
import {
  canRemoveQuickDueOption,
  filterCustomers,
  formatDirectoryPath,
  hasUnsavedSettingsInput,
  parseReminderTimeInput,
  planQuickDueCommit,
  quickDueEditorAfterSubmit,
  validateCustomerDisplayName,
  validateQuickDueOption,
} from "./settingsModel";

function option(label: string, days: number): QuickDueSetting {
  return { label, days };
}

describe("目录显示", () => {
  it("显示正常盘符路径，去掉 Windows 内部前缀", () => {
    expect(formatDirectoryPath(String.raw`\\?\C:\Pome\数据`)).toBe(String.raw`C:\Pome\数据`);
  });

  it("网络共享路径仍保留 UNC 双反斜杠", () => {
    expect(formatDirectoryPath(String.raw`\\?\UNC\server\share\Pome`)).toBe(String.raw`\\server\share\Pome`);
  });

  it("普通路径和无法安全转换的设备路径保持原样", () => {
    for (const path of [String.raw`I:\Pome`, String.raw`\\server\share`, String.raw`\\?\Volume{example}\Pome`, "/tmp/pome"]) {
      expect(formatDirectoryPath(path)).toBe(path);
    }
  });
});

describe("提醒时间输入", () => {
  it("接受规范 HH:mm", () => {
    expect(parseReminderTimeInput("09:00")).toEqual({ ok: true, normalized: "09:00" });
    expect(parseReminderTimeInput("23:59")).toEqual({ ok: true, normalized: "23:59" });
  });

  it("把合法的短格式规范化保存，不静默改值", () => {
    expect(parseReminderTimeInput("9:5")).toEqual({ ok: true, normalized: "09:05" });
    expect(parseReminderTimeInput(" 08:30 ")).toEqual({ ok: true, normalized: "08:30" });
  });

  it("拒绝非法时间并给出可读错误", () => {
    expect(parseReminderTimeInput("24:00").ok).toBe(false);
    expect(parseReminderTimeInput("12:60").ok).toBe(false);
    expect(parseReminderTimeInput("abc").ok).toBe(false);
    expect(parseReminderTimeInput("0905").ok).toBe(false);
    expect(parseReminderTimeInput("12:3:4").ok).toBe(false);
    expect(parseReminderTimeInput("").ok).toBe(false);
    expect(parseReminderTimeInput("-1:30").ok).toBe(false);
  });
});

describe("交付日期标签校验", () => {
  const existing = [option("今天", 0), option("明天", 1), option("下周", 7)];

  it("接受合法标签并 trim 标签名", () => {
    expect(validateQuickDueOption("  三天内  ", "3", existing, null)).toEqual({
      ok: true,
      option: option("三天内", 3),
    });
  });

  it("标签名 trim 后必须为 1-12 字", () => {
    expect(validateQuickDueOption("   ", "1", existing, null).ok).toBe(false);
    expect(validateQuickDueOption("一二三四五六七八九十十一", "1", existing, null).ok).toBe(true);
    expect(validateQuickDueOption("一二三四五六七八九十十一二", "1", existing, null).ok).toBe(false);
  });

  it("天数必须是 0-365 的整数", () => {
    expect(validateQuickDueOption("今天", "0", [], null)).toEqual({
      ok: true,
      option: option("今天", 0),
    });
    expect(validateQuickDueOption("最远", "365", [], null).ok).toBe(true);
    expect(validateQuickDueOption("太远", "366", [], null).ok).toBe(false);
    expect(validateQuickDueOption("负数", "-1", [], null).ok).toBe(false);
    expect(validateQuickDueOption("小数", "1.5", [], null).ok).toBe(false);
    expect(validateQuickDueOption("文字", "abc", [], null).ok).toBe(false);
    expect(validateQuickDueOption("空白", "  ", [], null).ok).toBe(false);
  });

  it("最多保留 12 项，不能继续添加", () => {
    const full = Array.from({ length: 12 }, (_, index) => option(`标签${index}`, 1));
    expect(validateQuickDueOption("新标签", "2", full, null).ok).toBe(false);
    expect(validateQuickDueOption("新标签", "2", full.slice(0, 11), null).ok).toBe(true);
  });

  it("重复名称忽略大小写拒绝，编辑自身不算重复", () => {
    expect(validateQuickDueOption("明天", "2", existing, null).ok).toBe(false);
    expect(validateQuickDueOption("MINGTIAN", "2", [option("mingtian", 1)], null).ok).toBe(false);
    expect(validateQuickDueOption("明天", "3", existing, 1)).toEqual({
      ok: true,
      option: option("明天", 3),
    });
  });
});

describe("交付日期标签移除保护", () => {
  it("最后一个标签不能移除", () => {
    expect(canRemoveQuickDueOption([option("今天", 0)])).toBe(false);
    expect(canRemoveQuickDueOption([option("今天", 0), option("明天", 1)])).toBe(true);
  });
});

describe("常用客户", () => {
  const customers: CustomerSetting[] = [
    { originalName: "李老板", displayName: "李老板", activeCount: 3 },
    { originalName: "wang", displayName: "王老师", activeCount: 0 },
    { originalName: "Acme", displayName: "Acme 公司", activeCount: 5 },
  ];

  it("按显示名或原始名忽略大小写过滤", () => {
    expect(filterCustomers(customers, "王").map((row) => row.originalName)).toEqual(["wang"]);
    expect(filterCustomers(customers, "acme").map((row) => row.originalName)).toEqual(["Acme"]);
    expect(filterCustomers(customers, "  ")).toHaveLength(3);
    expect(filterCustomers(customers, "不存在")).toEqual([]);
  });

  it("改名必须 trim 后非空且不超过 100 字", () => {
    expect(validateCustomerDisplayName("  新名字  ")).toEqual({ ok: true, displayName: "新名字" });
    expect(validateCustomerDisplayName("   ").ok).toBe(false);
    expect(validateCustomerDisplayName("长".repeat(100)).ok).toBe(true);
    expect(validateCustomerDisplayName("长".repeat(101)).ok).toBe(false);
  });
});

describe("返回前的未提交输入判断", () => {
  const clean = {
    reminderTimeInput: "09:00",
    reminderTimeError: null,
    savedReminderTime: "09:00",
    dailyReminderEnabled: true,
    apiKeyDraft: "",
    quickDueEditorOpen: false,
    customerRenaming: false,
  };

  it("全部已提交时不阻止返回", () => {
    expect(hasUnsavedSettingsInput(clean)).toBe(false);
  });

  it("非法或未保存的提醒时间视为未提交", () => {
    expect(hasUnsavedSettingsInput({ ...clean, reminderTimeInput: "25:00", reminderTimeError: "非法" })).toBe(true);
    expect(hasUnsavedSettingsInput({ ...clean, reminderTimeInput: "08:30" })).toBe(true);
  });

  it("提醒关闭时不比较时间输入", () => {
    expect(hasUnsavedSettingsInput({ ...clean, dailyReminderEnabled: false, reminderTimeInput: "" })).toBe(false);
  });

  it("Key 草稿、标签表单、改名编辑任一存在即视为未提交", () => {
    expect(hasUnsavedSettingsInput({ ...clean, apiKeyDraft: "sk-x" })).toBe(true);
    expect(hasUnsavedSettingsInput({ ...clean, quickDueEditorOpen: true })).toBe(true);
    expect(hasUnsavedSettingsInput({ ...clean, customerRenaming: true })).toBe(true);
  });
});

describe("标签编辑提交计划（下标错位防护）", () => {
  const abc = [option("A", 0), option("B", 1), option("C", 3)];

  it("A/B/C 中编辑 B 为 D：按原位置保存", () => {
    const plan = planQuickDueCommit(abc, "D", "2", { index: 1, originalLabel: "B" });
    expect(plan).toEqual({
      kind: "save",
      options: [option("A", 0), option("D", 2), option("C", 3)],
    });
  });

  it("保存前数组已变化（A 被删）：判定过期，不产出保存计划", () => {
    // 保存前删除了 A，数组只剩 B、C；下标 1 现在是 C，与进入编辑时的 B 不一致。
    const plan = planQuickDueCommit([option("B", 1), option("C", 3)], "D", "2", {
      index: 1,
      originalLabel: "B",
    });
    expect(plan.kind).toBe("stale");
    if (plan.kind === "stale") expect(plan.error).toContain("重新编辑");
  });

  it("编辑目标位置不存在（数组被缩短）时判定过期", () => {
    const plan = planQuickDueCommit([option("A", 0)], "D", "2", { index: 2, originalLabel: "C" });
    expect(plan.kind).toBe("stale");
  });

  it("过期不产出保存计划，调用方不得调用 update 覆盖另一项", () => {
    const plan = planQuickDueCommit([option("B", 1), option("C", 3)], "D", "2", {
      index: 1,
      originalLabel: "B",
    });
    expect(plan).not.toEqual(expect.objectContaining({ kind: "save" }));
  });

  it("目标一致但内容非法（重名）时返回校验错误而非过期", () => {
    const plan = planQuickDueCommit(abc, "A", "1", { index: 1, originalLabel: "B" });
    expect(plan.kind).toBe("invalid");
  });

  it("添加（target 为 null）按追加计划；上限已满时拒绝", () => {
    const plan = planQuickDueCommit(abc, "新标签", "2", null);
    expect(plan).toEqual({
      kind: "save",
      options: [...abc, option("新标签", 2)],
    });

    const full = Array.from({ length: 12 }, (_, index) => option(`标签${index}`, 1));
    expect(planQuickDueCommit(full, "新标签", "2", null).kind).toBe("invalid");
  });
});

describe("标签编辑表单提交结果（保存失败保留输入）", () => {
  const editing = { label: "D", days: "2", error: null };

  it("保存失败时保留输入并显示错误", () => {
    const next = quickDueEditorAfterSubmit(editing, { ok: false, message: "已存在同名标签。" });
    expect(next).toEqual({ label: "D", days: "2", error: "已存在同名标签。", closed: false });
  });

  it("服务保存失败同样保留输入", () => {
    const next = quickDueEditorAfterSubmit(editing, { ok: false, message: "保存失败" });
    expect(next).toEqual({ label: "D", days: "2", error: "保存失败", closed: false });
  });

  it("保存成功后关闭表单", () => {
    const next = quickDueEditorAfterSubmit(editing, { ok: true });
    expect(next.closed).toBe(true);
    expect(next.error).toBeNull();
  });
});
