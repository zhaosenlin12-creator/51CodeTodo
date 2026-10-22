/**
 * 场景词包：设置页顶部「场景」开关，切换整套显示文字。
 * 只改变显示文字，不改变底层字段与数据；三个场景是同一套字段的三套名字。
 * 「客户」只在工作场景出现——生活/学习场景下设置页不显示常用客户管理。
 */
export type FieldPackKey = "work" | "life" | "study";

export interface TodoWordPack {
  key: FieldPackKey;
  /** 场景名（胶囊标签） */
  scene: string;
  /** 对象字段名（客户/事项/科目） */
  customerLabel: string;
  /** 输入框占位符 */
  customerPlaceholder: string;
  /** 「客户」概念的无障碍名称 */
  customerAria: string;
  /** 卡片顶部「未填写来源」提示；为空表示不显示来源行 */
  noCustomer: string;
  /** 表单时间字段名 */
  receivedAtLabel: string;
  dueAtLabel: string;
  /** 标题字段名与占位符 */
  titleLabel: string;
  titlePlaceholder: string;
  /** 强调标签：工作场景「今日」，生活/学习「今天」 */
  todayWord: "今日" | "今天";
  /** 完成/交付动词：工作场景「交付」，生活/学习「完成」 */
  dueWord: "交付" | "完成";
}

export const sceneChoices = ["工作", "生活", "学习"] as const;

const fieldWordPacks: Record<FieldPackKey, TodoWordPack> = {
  work: {
    key: "work",
    scene: "工作",
    customerLabel: "来源",
    customerPlaceholder: "客户、领导或项目名称等",
    customerAria: "来源",
    noCustomer: "未填写来源",
    receivedAtLabel: "接收时间",
    dueAtLabel: "交付时间",
    titleLabel: "任务内容",
    titlePlaceholder: "待办事项",
    todayWord: "今日",
    dueWord: "交付",
  },
  life: {
    key: "life",
    scene: "生活",
    customerLabel: "事项",
    customerPlaceholder: "",
    customerAria: "事项",
    noCustomer: "",
    receivedAtLabel: "记录时间",
    dueAtLabel: "完成时间",
    titleLabel: "要点",
    titlePlaceholder: "要做什么",
    todayWord: "今天",
    dueWord: "完成",
  },
  study: {
    key: "study",
    scene: "学习",
    customerLabel: "主题",
    customerPlaceholder: "",
    customerAria: "主题",
    noCustomer: "未填主题",
    receivedAtLabel: "记录时间",
    dueAtLabel: "完成时间",
    titleLabel: "学习内容",
    titlePlaceholder: "学习要点",
    todayWord: "今天",
    dueWord: "完成",
  },
};

/** 设置里保存的是字段名（客户/事项/主题）；任意其他历史值一律回退默认工作场景。 */
export function wordPackFor(label: string | undefined): TodoWordPack {
  const key: FieldPackKey = label === "事项" ? "life" : label === "主题" || label === "科目" ? "study" : "work";
  return fieldWordPacks[key];
}

/** 设置页胶囊的当前选中场景名（工作/生活/学习）；旧值归一为工作。 */
export function sceneValue(label: string | undefined): string {
  return wordPackFor(label).scene;
}
