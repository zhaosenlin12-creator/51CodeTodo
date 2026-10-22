import { describe, expect, it } from "vitest";
import { dueWordsFor } from "./todoModel";
import { sceneValue, wordPackFor } from "./wordPacks";

describe("wordPacks 场景词包", () => {
  it("默认值与未知旧值回退工作场景", () => {
    expect(wordPackFor(undefined).key).toBe("work");
    expect(wordPackFor("测试222").key).toBe("work");
    expect(wordPackFor("来源").scene).toBe("工作");
  });

  it("生活与学习场景切换整套名称", () => {
    const life = wordPackFor("事项");
    expect(life.scene).toBe("生活");
    expect(life.customerLabel).toBe("事项");
    expect(life.noCustomer).toBe("");
    expect(life.titleLabel).toBe("要点");
    expect(life.receivedAtLabel).toBe("记录时间");

    const study = wordPackFor("主题");
    expect(study.scene).toBe("学习");
    expect(study.customerLabel).toBe("主题");
    expect(study.noCustomer).toBe("未填主题");
    expect(study.titleLabel).toBe("学习内容");
  });

  it("完成/交付动词按场景区分：工作=交付，生活/学习=完成", () => {
    expect(wordPackFor("来源").dueWord).toBe("交付");
    expect(wordPackFor("来源").dueAtLabel).toBe("交付时间");
    expect(wordPackFor("事项").dueWord).toBe("完成");
    expect(wordPackFor("事项").dueAtLabel).toBe("完成时间");
    expect(wordPackFor("主题").dueWord).toBe("完成");
    expect(wordPackFor("主题").dueAtLabel).toBe("完成时间");
  });

  it("dueWordsFor 生成整套到期标签", () => {
    const work = dueWordsFor("交付");
    expect(work.today).toBe("今日交付");
    expect(work.expiringToday).toBe("今日到期");
    expect(work.late(2)).toBe("逾期 2 天交付");
    expect(work.unscheduled).toBe("未设交付日期");
    const life = dueWordsFor("完成");
    expect(life.today).toBe("今天完成");
    expect(life.expiringToday).toBe("今天到期");
    expect(life.clear).toBe("不设完成日期");
  });

  it("场景词包带今日/今天强调词", () => {
    expect(wordPackFor("来源").todayWord).toBe("今日");
    expect(wordPackFor("事项").todayWord).toBe("今天");
    expect(wordPackFor("主题").todayWord).toBe("今天");
  });

  it("历史值「科目」仍归入学习场景（兼容切换前的存储值）", () => {
    expect(wordPackFor("科目").key).toBe("study");
    expect(wordPackFor("科目").customerLabel).toBe("主题");
  });

  it("sceneValue 返回场景名，旧值归一为工作", () => {
    expect(sceneValue("来源")).toBe("工作");
    expect(sceneValue("事项")).toBe("生活");
    expect(sceneValue("科目")).toBe("学习");
    expect(sceneValue("测试222")).toBe("工作");
  });
});
