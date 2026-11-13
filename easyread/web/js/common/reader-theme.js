/* Zotero 阅读配色独立于应用界面主题；颜色只作用于阅读层。 */
(function (PR) {
  "use strict";
  PR.READER_THEMES = [
    { id: "original", label: "原始", background: "#FFFFFF", foreground: "#000000" },
    { id: "dark", label: "深色", background: "#2E3440", foreground: "#D8DEE9" },
    { id: "black", label: "黑色", background: "#000000", foreground: "#FFFFFF" },
    { id: "snow", label: "雪色", background: "#ECEFF4", foreground: "#3B4252" },
    { id: "sepia", label: "棕褐", background: "#F4ECD8", foreground: "#5B4636" }
  ];
  const find = id => PR.READER_THEMES.find(t => t.id === id);
  PR.readerThemeValue = function (prefs = PR.prefs || PR.ls.get("easyread-prefs", {})) {
    if (find(prefs.readerTheme)) return prefs.readerTheme;
    const dark = prefs.theme === "dark" || (prefs.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    return dark ? "dark" : "sepia";
  };
  const watched = new WeakSet();
  PR.applyReaderTheme = function (doc = document, id = PR.readerThemeValue()) {
    const theme = find(id) || find(PR.readerThemeValue()), root = doc.documentElement;
    const tone = ["dark", "black"].includes(theme.id) ? "dark" : "light";
    root.dataset.readerTheme = theme.id;
    root.dataset.readingTone = tone;
    if (doc !== document) {
      root.dataset.readerContent = ""; root.dataset.theme = tone;
      if (!watched.has(doc)) {
        watched.add(doc);
        doc.addEventListener("pointerdown", () => PR.closeReaderThemePicker?.());
        doc.addEventListener("keydown", escape, true);
      }
    }
    return theme;
  };
  PR.readerThemeChoices = function (id = PR.readerThemeValue()) {
    return '<div class="reader-theme-grid" role="group" aria-label="阅读配色">' + PR.READER_THEMES.map(t =>
      '<button type="button" data-reader-theme="' + t.id + '" aria-pressed="' + (t.id === id) +
      '" style="background:' + t.background + ';color:' + t.foreground + '">' + t.label + '</button>').join("") + '</div>';
  };
  PR.setReaderTheme = function (id) {
    if (!find(id)) return;
    PR.prefs ||= PR.ls.get("easyread-prefs", {});
    PR.prefs.readerTheme = id;
    PR.ls.set("easyread-prefs", Object.assign(PR.ls.get("easyread-prefs", {}), { readerTheme: id }));
    PR.savePrefs("reader", { readerTheme: id });
    PR.applyReaderTheme(document, id); PR.emit("reader-theme-changed", id);
  };
  let picker, opener;
  PR.closeReaderThemePicker = function (restoreFocus = false) {
    if (!picker || picker.hidden) return;
    picker.hidden = true; opener?.setAttribute("aria-expanded", "false");
    if (restoreFocus) opener?.focus({ preventScroll: true });
  };
  function escape(e) {
    if (e.key === "Escape" && picker && !picker.hidden) {
      e.preventDefault(); e.stopImmediatePropagation(); PR.closeReaderThemePicker(true);
    }
  }
  PR.toggleReaderThemePicker = function (button) {
    if (picker && !picker.hidden) return PR.closeReaderThemePicker();
    if (!picker) {
      picker = document.createElement("section"); picker.id = "readerThemePicker";
      picker.className = "reader-theme-picker"; picker.setAttribute("role", "dialog");
      picker.setAttribute("aria-label", "阅读配色"); document.body.append(picker);
      picker.addEventListener("click", e => {
        const b = e.target.closest("[data-reader-theme]");
        if (b) { PR.setReaderTheme(b.dataset.readerTheme); PR.closeReaderThemePicker(true); }
      });
    }
    opener = button; opener.setAttribute("aria-controls", picker.id); opener.setAttribute("aria-expanded", "true");
    picker.innerHTML = '<div class="reader-theme-title">阅读配色</div>' + PR.readerThemeChoices(); picker.hidden = false;
    const box = button.getBoundingClientRect(), width = Math.min(320, innerWidth - 24);
    picker.style.width = width + "px";
    picker.style.left = Math.max(12, Math.min(innerWidth - width - 12, box.right - width)) + "px";
    const height = picker.getBoundingClientRect().height;
    picker.style.top = Math.max(12, Math.min(innerHeight - height - 12, box.bottom + 8)) + "px";
    picker.querySelector('[aria-pressed="true"]').focus({ preventScroll: true });
  };
  document.addEventListener("pointerdown", e => { if (!e.target.closest("#readerThemePicker,#theme")) PR.closeReaderThemePicker(); });
  document.addEventListener("keydown", escape, true);
  window.addEventListener("resize", () => PR.closeReaderThemePicker());
})(window.PR);
