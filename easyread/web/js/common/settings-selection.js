(function (PR) {
  "use strict";
  const input = (label, key, value, placeholder, type) => '<label class="field"><span>' + label + '</span><input class="input" data-st-setting="' + key + '" type="' + (type || "text") + '" value="' + PR.esc(value || "") + '" placeholder="' + PR.esc(placeholder || "") + '" autocomplete="off"></label>';
  PR.settingsTabs.selection = {
    render(s) {
      const c = s.cfg.selection_translation;
      const select = (label, key, choices, value) => '<label class="field"><span>' + label + '</span><select class="input" data-st-setting="' + key + '">' + PR.opt(choices, value) + '</select></label>';
      let h = '<p class="set-lead">选中文字后，在下方自动显示译文。</p>' +
        '<label class="check"><input type="checkbox" data-st-setting="enabled"' + (c.enabled ? ' checked' : '') + '>开启自动选词翻译</label>' +
        '<div class="grid2">' + select("翻译来源", "engine", [["codex", "Codex（现有登录）"], ["api", "API"]], c.engine) +
        select("目标语言", "target_language", [["zh-CN", "中文（选中中文时译为英文）"], ["en", "英文"]], c.target_language) + '</div>';
      if (c.engine === "codex") {
        const available = s.models?.codex?.models || [];
        const auto = available.some(m => m.id === "gpt-6-luna") ? "自动：gpt-6-luna（优先速度）" : "自动：" + (s.cfg.codex.model || "Codex 默认模型");
        h += '<div class="grid2">' + input("选词翻译模型", "codex.model", c.codex.model, auto) +
          select("选词翻译推理强度", "codex.reasoning_effort", [["low", "low（优先速度）"], ["medium", "medium"], ["high", "high"]], c.codex.reasoning_effort) + '</div><p class="hint">模型留空时，优先使用当前 Codex 名单中的 GPT-6 Luna；不可用时沿用已有模型名称。</p>';
      } else {
        h += input("API 基础地址", "api.base_url", c.api.base_url, "https://服务商地址/v1") +
          '<div class="grid2">' + input("模型名称", "api.model", c.api.model, "服务商提供的模型 ID") +
          select("API 协议", "api.protocol", [["chat_completions", "OpenAI 兼容 Chat Completions"], ["responses", "OpenAI Responses"]], c.api.protocol) + '</div>' +
          input("API Key", "api.api_key", c.api.api_key, c.api.has_key ? "已保存，留空保留" : "在这里填写，保存在本机", "password") +
          input("API 推理强度（可选）", "api.reasoning_effort", c.api.reasoning_effort, "留空使用服务商默认；按支持填写 none / low / high / max") +
          '<p class="hint">支持流式返回。基础地址也可以填写完整的接口地址；本机无需密钥的接口可留空 Key。</p>';
      }
      return h + '<p class="hint">这些设置只用于选词翻译。原有问 AI 和全文翻译仍使用各自的配置。重复选中同一处会直接使用缓存译文。</p>';
    },
    sync(s, dlg) {
      const c = s.cfg.selection_translation;
      PR.$$("[data-st-setting]", dlg).forEach((el) => {
        const [a, b] = el.dataset.stSetting.split(".");
        const value = el.type === "checkbox" ? el.checked : el.value;
        if (b) c[a][b] = value; else c[a] = value;
      });
    },
    change(e, s, dlg) {
      if (e.target.dataset.stSetting !== "engine") return false;
      this.sync(s, dlg); return true;
    },
  };
})(window.PR);
