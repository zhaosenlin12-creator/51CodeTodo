import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AiKeySection from "./AiKeySection";

describe("AiKeySection 配置状态", () => {
  it("把已保存状态收进厂商按钮和输入框，不常驻重复标题或长说明", () => {
    const html = renderToStaticMarkup(
      <AiKeySection
        provider="deepseek"
        keyConfigured={{ minimax: false, deepseek: true, qwen: false, glm: false }}
        busy={false}
        draft=""
        onDraftChange={() => undefined}
        onProviderChange={() => undefined}
        onSaveKey={() => undefined}
        onRequestClearKey={() => undefined}
      />,
    );

    expect(html).toContain("DeepSeek Key 已保存");
    expect(html).toContain('aria-label="DeepSeek，Key 已保存"');
    expect(html).toContain("settings-key-provider-configured");
    expect(html).not.toContain("AI 识别服务");
    expect(html).not.toContain(">API Key<");
    expect(html).not.toContain("Key 加密保存在本机");
    expect(html).not.toContain("settings-key-state");
  });

  it("未配置的当前厂商提示用户粘贴对应 Key", () => {
    const html = renderToStaticMarkup(
      <AiKeySection
        provider="qwen"
        keyConfigured={{ minimax: false, deepseek: false, qwen: false, glm: false }}
        busy={false}
        draft=""
        onDraftChange={() => undefined}
        onProviderChange={() => undefined}
        onSaveKey={() => undefined}
        onRequestClearKey={() => undefined}
      />,
    );

    expect(html).toContain('placeholder="粘贴 Qwen API Key"');
    expect(html).toContain('aria-label="Qwen API Key"');
    expect(html).not.toContain("Key 已保存");
  });

  it("来源切换未完成时禁用厂商、Key 输入和保存操作", () => {
    const html = renderToStaticMarkup(
      <AiKeySection
        provider="deepseek"
        keyConfigured={{ minimax: false, deepseek: true, qwen: false, glm: false }}
        busy
        draft="new-key"
        onDraftChange={() => undefined}
        onProviderChange={() => undefined}
        onSaveKey={() => undefined}
        onRequestClearKey={() => undefined}
      />,
    );

    expect(html.match(/disabled=""/g)).toHaveLength(7);
  });
});
