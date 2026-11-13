/* 右侧“问 AI”面板：边读边和模型实时对话，回答逐字流出来。
   - 多个对话：顶部点标题展开对话列表，可以新建、切换、改名、删除（存在论文目录的 chat.json）。
   - 模型：输入框左下角切换，名单在“设置 → 问 AI”里配（默认 Claude Opus 5.5 / Sonnet 5.5 / GPT）。
   - 上下文：默认带上你正在读的段落；可以引用多段——选中文字点“问 AI”、段落操作条的“问 AI”，
     或者把选中的文字直接拖进输入框，每段一个小标签，可以逐个去掉。
   - 你的划线、笔记、问题不会每次都带；问到“标红的”“划线”“我的笔记”时，后台才把对应颜色的标记找出来。
   - 页边笔记里的问题也从这里回答，答案同时写成那条笔记的回复。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const panel = () => PR.$("#chatpanel");
  const pinLabel = () => PR.noteSurface ? "保存到笔记" : "放到页边";
  const st = { loaded: false, threads: [], cur: null, models: [], def: "", model: "", listOpen: false, menuOpen: false, refs: [], auto: null, noAuto: false, streaming: null, draft: "", images: [] };

  PR.canChat = () => PR.store.mode === "server";
  /* 在线演示 / 离线版：带着对话记录时可以看，不能问 */
  PR.chatView = () => PR.canChat() || !!(S.chat && (S.chat.threads || []).length);
  PR.chatOpen = () => PR.side === "chat";
  PR.toggleChat = function (force) {
    const open = force != null ? force : PR.side !== "chat";
    PR.openSide(open ? "chat" : null);
    if (open) { autoContext(); load().then(() => { render(); focusInput(); }); render(); }
  };
  const focusInput = () => setTimeout(() => { const t = PR.$("#chatInput"); t && t.focus(); }, 300);

  function autoContext() {
    const id = (PR.currentBlock && PR.currentBlock()) || PR.readingBlock();
    st.auto = PR.blockById[id] ? { anchor: id, quote: "" } : null;
  }
  function addRef(anchor, quote) {
    if (!PR.blockById[anchor]) return false;
    quote = (quote || "").trim();
    if (st.refs.some((r) => r.anchor === anchor && r.quote === quote)) return false;
    st.refs = st.refs.filter((r) => !(r.anchor === anchor && !r.quote && quote)).concat({ anchor, quote });  // 同段先引整段、再选一句：换成那句
    return true;
  }
  /* 这次提问带哪几段：手动引用的；没有就用正在读的那段 */
  const sendRefs = () => (st.refs.length ? st.refs.slice() : st.auto && !st.noAuto ? [st.auto] : []);

  /* 外部入口：段落操作条、选中文字（都是“加一段引用”），笔记卡片（直接问这一条） */
  PR.chatAsk = function (opts) {
    if (PR.side !== "chat") { PR.openSide("chat"); autoContext(); }
    load().then(() => {
      if (opts.text) return send(opts.text, opts.note, [{ anchor: opts.anchor, quote: opts.quote || "" }]);
      const added = addRef(opts.anchor, opts.quote);
      if (opts.draft) st.draft = opts.draft;
      render(); focusInput();
      if (added && st.refs.length > 1) PR.toast("已引用 " + st.refs.length + " 段", null, 1000);
    });
  };

  let loading = null;
  async function load(force) {
    if (st.loaded && !force) return;
    if (loading) return loading;
    loading = loadThreads();
    try { await loading; } finally { loading = null; }
  }
  async function loadThreads() {
    if (!PR.canChat()) {
      st.threads = (S.chat && S.chat.threads) || []; st.cur = st.cur || (st.threads[0] || {}).id || null; st.loaded = true;
      return;
    }
    try {
      const d = await PR.api("/api/p/" + PR.pid + "/chat");
      st.threads = d.threads || []; st.models = d.models || []; st.def = d.default;
      if (!st.model || !st.models.some((m) => m.id === st.model)) st.model = st.def;
      if (st.cur && !st.threads.some((t) => t.id === st.cur)) st.cur = null;
      st.loaded = true;
    } catch (e) { PR.toast("读不到对话记录：" + PR.esc(e.message)); }
  }
  PR.on("settings-saved", () => { if (st.loaded) load(true).then(render); });

  const thread = () => st.threads.find((t) => t.id === st.cur) || null;
  const modelOf = (id) => st.models.find((m) => m.id === id) || st.models[0] || { label: "模型" };
  const imageUrl = (image) => image.preview || (/^\/p\/[^/]+\/chat-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(image.url || "") ? image.url : "");
  function imagesHtml(images, removable) {
    return !images?.length ? "" : '<div class="ch-images" aria-label="图片附件">' + images.map((image, i) =>
      '<figure class="ch-image"><img src="' + PR.esc(imageUrl(image)) + '" alt="' + PR.esc(image.name || "图片附件") + '">' +
      (removable ? '<button type="button" data-c="remove-image" data-i="' + i + '" aria-label="移除图片 ' + (i + 1) + '">×</button>' : "") + "</figure>").join("") + "</div>";
  }
  function addImages(files) {
    if (st.streaming) return PR.toast("请等本轮回答结束再添加图片");
    for (const file of files) {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { PR.toast("请使用 PNG、JPEG 或 WebP 图片"); continue; }
      if (file.size > 10 * 1024 * 1024) { PR.toast("每张图片不能超过 10 MB"); continue; }
      if (st.images.length >= 4) { PR.toast("一次最多附 4 张图片"); break; }
      st.images.push({ file, name: file.name || "截图.png", preview: URL.createObjectURL(file) });
    }
    render(); focusInput();
  }

  function plainTex(t) {
    return (t || "").replace(/\$\$?([^$]*)\$\$?/g, (m, x) => x.replace(/\\([a-zA-Z]+)\s*/g, (y, name) => ({ mu: "μ", sigma: "σ", epsilon: "ε", alpha: "α", beta: "β", theta: "θ", pi: "π", sum: "Σ", mid: "|", succ: "≻", log: "log ", exp: "exp " })[name] || "").replace(/[{}\\^_]/g, ""));
  }
  function ctxLabel(c) {
    if (!c || !PR.blockById[c.anchor]) return "";
    const b = PR.blockById[c.anchor];
    if (b.type === "math" && !c.quote) return (PR.sectionOf ? PR.sectionOf(c.anchor) + " · " : "") + (b.tag ? "公式 (" + b.tag + ")" : "一个公式");
    const text = plainTex(c.quote || PR.textFor(PR.blockKeys(b)[0] || b.id) || b.caption_zh || b.tex || "").replace(/\*\*|`/g, "");  // 先去公式记号再去粗体，不然 $ 已被 PR.plain 去掉、TeX 原样露出来
    const sec = PR.sectionOf ? PR.sectionOf(c.anchor) : "";
    return (sec ? sec + " · " : "") + "「" + text.slice(0, 36) + (text.length > 36 ? "…" : "") + "」";
  }
  function refChip(r, i, auto) {
    const label = ctxLabel(r);
    return '<span class="chip-ctx' + (auto ? " auto" : "") + '" title="' + PR.esc(label) + '">' + PR.icon(auto ? "book" : "link", "sm") + "<span>" + (auto ? "正在读：" : r.quote ? "这句：" : "") + PR.esc(label) +
      '</span><button data-c="' + (auto ? "noauto" : "unref") + '" data-i="' + i + '" title="不带这段">×</button></span>';
  }
  function markCounts() {
    const out = {};
    PR.myNotes().forEach((n) => { if (n.quote) out[n.color || "yellow"] = (out[n.color || "yellow"] || 0) + 1; });
    return out;
  }
  const colorName = (c) => (PR.HL_COLORS.find(([k]) => k === c) || [c, c])[1];
  const when = (iso) => (iso ? PR.shortTime(iso) : "");

  /* ---------- 画面 ---------- */
  function headHtml() {
    const t = thread();
    return '<div class="ch-head"><button class="ch-title" data-c="list" title="全部对话">' + PR.icon("menu", "sm") + "<span>" + PR.esc(t ? t.title : "新对话") + "</span>" + PR.icon("chevron", "sm") + "</button>" +
      '<span class="grow"></span><button class="btn icon" data-c="new" title="新对话">' + PR.icon("plus", "sm") + '</button><button class="btn icon" data-c="close" title="关闭">×</button></div>' +
      (st.listOpen ? listHtml() : "");
  }
  function listHtml() {
    const rows = st.threads.map((t) => '<div class="ch-thread' + (t.id === st.cur ? " on" : "") + '" data-t="' + PR.esc(t.id) + '"><div class="tt">' + PR.esc(t.title) + "</div>" +
      '<div class="tm">' + Math.round((t.messages || []).length / 2) + " 问 · " + PR.esc(when(t.updated)) + "</div>" +
      '<button class="tx" data-c="rename" title="改名">' + PR.icon("edit", "sm") + '</button><button class="tx" data-c="del" title="删除">' + PR.icon("trash", "sm") + "</button></div>").join("");
    return '<div class="ch-list"><button class="ch-thread newt" data-c="new">' + PR.icon("plus", "sm") + "新对话</button>" + (rows || '<div class="hint" style="padding:10px 12px">还没有对话。</div>') + "</div>";
  }
  function msgHtml(m) {
    if (m.role === "user") {
      return '<div class="cm user"><div class="bubble">' + imagesHtml(m.images, false) + PR.esc(m.content).replace(/\n/g, "<br>") + "</div>" +
        ((m.refs && m.refs.length ? m.refs : m.anchor ? [m] : []).filter((r) => PR.blockById[r.anchor])
          .map((r) => '<button class="cm-ctx" data-c="go" data-anchor="' + PR.esc(r.anchor) + '">' + PR.icon("link", "sm") + "<span>" + PR.esc(ctxLabel(r)) + "</span></button>").join("")) + "</div>";
    }
    const live = st.streaming && st.streaming.msg === m;
    const timing = m.timing && Number.isFinite(m.timing.total_s) ?
      '<small class="ch-time">' + (Number.isFinite(m.timing.first_token_s) ? m.timing.first_token_s.toFixed(1) + ' 秒首字 · ' : '') + m.timing.total_s.toFixed(1) + ' 秒完成</small>' : '';
    const usage = m.timing && m.timing.usage;
    const cache = usage ? '<small class="ch-time ch-cache" title="' +
      (usage.basis === 'last_model_call' ? '仅统计本轮最后一次模型调用' : '本轮所有模型调用的实际用量') + '">' +
      (usage.available ? '缓存 ' + usage.cached_input_tokens.toLocaleString() + ' / ' + usage.input_tokens.toLocaleString() + ' token' +
        (Number.isFinite(usage.cache_hit_ratio) ? ' · ' + (usage.cache_hit_ratio * 100).toFixed(1) + '%' : '') : '缓存统计未知') + '</small>' : '';
    return '<div class="cm ai' + (m.error ? " err" : "") + '" data-id="' + PR.esc(m.id || "") + '"><div class="who"><span class="av">' + PR.icon("sparkle", "sm") + "</span>" + PR.esc(m.model || "AI") + (live ? ' <span class="spin"></span>' : "") + "</div>" +
      '<div class="body">' + (m.error ? PR.esc(m.error) + (m.save_task ? '<button class="btn" data-c="save-answer" data-task="' + PR.esc(m.save_task) + '">再次保存（不调用AI）</button>' : '') : m.content ? PR.mdBlocks(m.content) : '<p class="thinking"><i></i><i></i><i></i></p>') + "</div>" +
      (!live && !m.error && m.id ? '<div class="acts"><button data-c="copy">' + PR.icon("copy", "sm") + "复制</button>" + (PR.canChat() ? '<button data-c="pin" title="保存这条 AI 回答">' + PR.icon("note", "sm") + pinLabel() + "</button>" : "") + timing + cache + "</div>" : "") + "</div>";
  }
  function emptyHtml() {
    const counts = markCounts();
    const colors = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const sug = ["这段在说什么？用大白话讲一遍", "这个公式每一项是什么意思？怎么推出来的？", "这里的结论靠得住吗？有什么前提？"];
    if (colors.length) sug.unshift("我标" + colorName(colors[0]) + "的那些地方，彼此有什么联系？", "把我划过线的内容串成一条主线讲讲");
    return '<div class="ch-empty">' + PR.logo("hero") + "<b>边读边问</b><p>默认带上你正在读的段落，也可以引用多段一起问。" + (colors.length ? "问到“标" + colorName(colors[0]) + "的”“划线”时，会自动找出你的 " + Object.values(counts).reduce((a, b) => a + b, 0) + " 处标记。" : "") + "</p>" +
      '<div class="chips">' + sug.map((q) => '<button data-c="suggest">' + PR.esc(q) + "</button>").join("") + "</div></div>";
  }
  function composerHtml() {
    if (!PR.canChat()) {
      const repo = (S.demo && S.demo.repo) || "https://github.com/Edwardxlai/easyread";
      return '<div class="ch-compose ch-readonly"><b>这是演示里的对话记录，这里不能提问</b><span>装到自己电脑上之后，边读边问 Claude、GPT 或免费模型；可以引用多段，问“我标红的那些”也能找到。</span>' +
        '<a class="btn sm accent" href="' + repo + '" target="_blank" rel="noopener">去 GitHub 安装 ↗</a></div>';
    }
    const m = modelOf(st.model);
    const chips = st.refs.length ? st.refs.map((r, i) => refChip(r, i)).join("") : st.auto && !st.noAuto ? refChip(st.auto, 0, true) : "";
    const menu = st.menuOpen ? '<div class="ch-menu">' + st.models.map((x) => '<button data-c="model" data-m="' + PR.esc(x.id) + '" class="' + (x.id === st.model ? "on" : "") + '"' + (x.ready === false ? ' disabled title="' + PR.esc(x.hint) + '"' : "") + ">" +
      "<b>" + PR.esc(x.label) + "</b><small>" + PR.esc(x.ready === false ? x.hint : [x.source, x.id === st.def ? "默认" : ""].filter(Boolean).join(" · ")) + "</small></button>").join("") +
      '<hr><button data-c="manage">' + PR.icon("gear", "sm") + "管理模型…</button></div>" : "";
    return '<div class="ch-compose">' + (chips ? '<div class="ch-chips">' + chips + "</div>" : "") +
      (st.refs.length < 2 && !st.streaming ? '<div class="ch-tip">想一起问几段？把正文里选中的文字拖进来，或点段落上的“问 AI”</div>' : "") +
      imagesHtml(st.images, true) + '<textarea id="chatInput" rows="1" placeholder="问点什么，也可以粘贴截图…（Enter 发送）">' + PR.esc(st.draft) + "</textarea>" +
      '<input id="chatImageFile" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden>' +
      '<div class="ch-bar"><button class="ch-model" data-c="menu" title="换模型">' + PR.esc(m.label) + PR.icon("chevron", "sm") + "</button>" + menu +
      '<button type="button" class="ch-add-image" data-c="add-image" title="添加图片，也可直接粘贴截图"' + (st.streaming ? " disabled" : "") + '>图片</button>' +
      '<span class="grow"></span>' + (st.streaming ? '<button class="ch-send stop" data-c="stop" title="停止">' + PR.icon("stop", "sm") + "</button>"
        : '<button class="ch-send" data-c="send" title="发送（Enter）">' + PR.icon("arrowUp", "sm") + "</button>") + "</div></div>";
  }
  // Cache only rendered views. chat.json remains the source of truth, and a
  // bounded cache releases inactive histories instead of retaining every chat.
  const histories = new Map();
  let historyContext = [], shell = null;
  function messageNodes(t, messages) {
    const context = [PR.pid, S.paper, PR.blockById, PR.refById, PR.xindex, PR.canChat(), pinLabel()];
    if (context.some((v, i) => v !== historyContext[i])) { histories.forEach(r => r.box.remove()); histories.clear(); historyContext = context; }
    const key = t.id || t, old = histories.get(key), previous = old?.entries || new Map();
    const specs = messages.map((m, i) => {
      const live = st.streaming?.msg === m;
      const key = 'index:' + i + ':' + (m.id || m.role);
      // Streamed content is updated by StreamingMarkdown; shell changes must not
      // replace that live body. Completion produces one canonical final render.
      const signature = JSON.stringify([live, live ? {...m, content: null, timing: null} : m]);
      const cached = previous.get(key);
      return {key, signature, message: m, entry: cached?.signature === signature ? cached : null};
    });
    const missing = specs.filter(s => !s.entry);
    if (missing.length) {
      const html = missing.map(s => msgHtml(s.message)), template = document.createElement('template');
      template.innerHTML = html.join('');
      [...template.content.children].forEach((node, i) => {
        missing[i].entry = {node, signature: missing[i].signature, size: html[i].length};
      });
    }
    const record = {entries: new Map(specs.map(s => [s.key, s.entry])), box: old?.box || newHistoryBox()};
    histories.delete(key); histories.set(key, record);
    const size = () => [...histories.values()].reduce((sum, r) => sum + [...r.entries.values()].reduce((n, e) => n + e.size, 0), 0);
    const count = () => [...histories.values()].reduce((sum, r) => sum + r.entries.size, 0);
    while (histories.size > 5 || count() > 200 || size() > 4000000) { const oldest = histories.keys().next().value; histories.get(oldest).box.remove(); histories.delete(oldest); }
    record.nodes = specs.map(s => s.entry.node);
    return record;
  }
  function pruneHistories() {
    // The server assigns a new conversation id during its first stream. Move
    // that temporary view to its durable key without replacing its live body.
    for (const pending of st.threads) if (pending.id && histories.has(pending)) {
      const record = histories.get(pending); histories.delete(pending); histories.set(pending.id, record);
    }
    for (const k of histories.keys()) if (!st.threads.some(x => (x.id || x) === k)) { histories.get(k).box.remove(); histories.delete(k); }
  }
  function newHistoryBox() {
    const box = document.createElement('div'); box.className = 'ch-scroll';
    box.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
    return box;
  }
  function activateHistory(box) {
    if (box.parentElement !== shell.views) shell.views.append(box);
    const flex = shell.flex;
    for (const view of [...shell.views.children]) {
      if (view !== box && view !== shell.emptyBox && ![...histories.values()].some(r => r.box === view)) { view.remove(); continue; }
      const active = view === box;
      // Native PDF panels use block flow; the web/reflow panels use flex.
      // Keep the legacy PDF scroll area and composer in normal document flow.
      view.style.position = flex || !active ? 'absolute' : 'relative';
      view.style.inset = flex || !active ? '0' : 'auto';
      view.style.height = flex ? '100%' : 'auto';
      view.style.visibility = active ? '' : 'hidden'; view.inert = !active;
      if (active) { view.id = 'chatList'; view.removeAttribute('aria-hidden'); }
      else { view.removeAttribute('id'); view.setAttribute('aria-hidden', 'true'); }
    }
    shell.box = box;
  }
  function render(preserveScroll = false) {
    const el = panel();
    if (!el) return;
    const previous = PR.$('#chatList'), top = previous?.scrollTop || 0;
    const follow = !previous || previous.scrollHeight - top - previous.clientHeight < 160;
    const ta = PR.$('#chatInput'), focused = ta && document.activeElement === ta;
    const selection = ta && [ta.selectionStart, ta.selectionEnd, ta.selectionDirection];
    if (ta) st.draft = ta.value;
    if (!shell || shell.views.parentElement !== el) {
      const head = document.createElement('div'), views = document.createElement('div'), compose = document.createElement('div');
      head.style.display = compose.style.display = 'contents'; views.style.cssText = 'flex:1;min-height:0;position:relative';
      el.replaceChildren(head, views, compose); shell = {head, views, compose, emptyBox: newHistoryBox()};
    }
    shell.flex = getComputedStyle(el).display === 'flex';
    const header = headHtml(), composer = composerHtml();
    if (shell.header !== header) { shell.head.innerHTML = header; shell.header = header; }
    pruneHistories();
    const t = thread(), messages = t?.messages || [];
    let box;
    if (messages.length) {
      const record = messageNodes(t, messages), nodes = record.nodes; box = record.box;
      if (!box.children.length) box.append(...nodes);
      else {
        nodes.forEach((node, i) => { if (box.children[i] !== node) box.insertBefore(node, box.children[i] || null); });
        while (box.children.length > nodes.length) box.lastElementChild.remove();
      }
    } else {
      box = shell.emptyBox;
      const html = st.loaded ? emptyHtml() : '<p class="hint" style="padding:20px">加载中…</p>';
      if (shell.empty !== html) { box.innerHTML = html; shell.empty = html; }
    }
    activateHistory(box);
    if (shell.composer !== composer) { shell.compose.innerHTML = composer; shell.composer = composer; }
    box.scrollTop = preserveScroll && !follow ? top : box.scrollHeight;
    const input = PR.$('#chatInput');
    if (input) {
      PR.autosize(input);
      if (focused && input !== ta) { input.focus({preventScroll: true}); input.setSelectionRange(...selection); }
    }
  }
  // Freeze complete Markdown blocks; an unfinished fence/table stays in the tail.
  // Rendering and final serialization still use the original Markdown parser.
  class StreamingMarkdown {
    constructor(node) { this.node=node; this.text=''; this.offset=0; this.context=[]; this.reset(); }
    reset() { this.offset=0; this.tail=''; this.anchor=document.createComment('stream-tail'); this.node.replaceChildren(this.anchor); }
    boundary(text) {
      let start=0,cut=0,fence=null,end;
      while((end=text.indexOf('\n',start))!==-1) {
        const line=text.slice(start,end),match=line.match(/^\s{0,3}(`{3,}|~{3,})[^`]*$/);
        if(fence) { if(new RegExp('^\\s{0,3}'+fence[0]+'{'+fence.length+',}\\s*$').test(line))fence=null; }
        else if(match)fence=match[1];
        else if(!line.trim())cut=end+1;
        start=end+1;
      }
      return cut;
    }
    update(value) {
      const text=String(value||'').replace(/\r\n?/g,'\n'),context=[PR.blockById,PR.refById,PR.xindex];
      if(!text.startsWith(this.text)||context.some((v,i)=>v!==this.context[i]))this.reset();
      this.context=context;this.text=text;
      const rest=text.slice(this.offset),cut=this.boundary(rest);
      const html=PR.mdBlocks(rest.slice(cut));
      if(!cut&&html===this.tail)return;
      const range=document.createRange();range.setStartAfter(this.anchor);range.setEnd(this.node,this.node.childNodes.length);range.deleteContents();
      if(cut) {
        const template=document.createElement('template');template.innerHTML=PR.mdBlocks(rest.slice(0,cut));
        this.node.insertBefore(template.content,this.anchor);this.offset+=cut;
      }
      this.node.insertAdjacentHTML('beforeend',html);this.tail=html;
    }
  }
  function renderLive() {
    if (st.streaming?.thread && thread() !== st.streaming.thread) return;
    const node = st.streaming && PR.$("#chatList .cm.ai:last-child .body");
    if (!node) return;
    const box = PR.$("#chatList"),follow=box.scrollHeight-box.scrollTop-box.clientHeight<160;
    if(st.streaming.msg.content){
      if(st.streaming.renderer?.node!==node)st.streaming.renderer=new StreamingMarkdown(node);
      st.streaming.renderer.update(st.streaming.msg.content);
    }
    if(follow)box.scrollTop=box.scrollHeight;
  }
  const renderLiveSoon = PR.throttle(renderLive, 60);

  /* ---------- 发送 ---------- */
  async function send(text, noteId, only) {
    text = (text || "").trim();
    if ((!text && !st.images.length) || st.streaming) return;
    const images = only ? [] : st.images.slice();
    if (!text && !images.length) return;
    text ||= "请解释所附图片，并结合当前论文上下文。";
    const refs = only || sendRefs();
    const c = refs[0] || null;
    let t = thread();
    if (!t) { t = { id: null, title: text.slice(0, 22), messages: [], updated: PR.nowIso() }; st.threads.unshift(t); }
    const user = { role: "user", content: text, anchor: c ? c.anchor : null, quote: c ? c.quote : "", note: noteId || null, refs };
    if (images.length) user.images = images;
    const msg = { role: "assistant", content: "", model: modelOf(st.model).label };
    t.messages.push(user, msg);
    const ctrl = new AbortController();
    st.streaming = { ctrl, msg, thread: t };
    st.draft = ""; st.listOpen = false; st.menuOpen = false;
    if (!only) st.images = [];
    if (PR.$("#chatInput")) PR.$("#chatInput").value = "";
    if (noteId) { PR.asking.add(noteId); PR.renderMargin(); }
    render();
    const attachments = [];
    let uploaded = !images.length;
    try {
      await PR.flush(); // 新划线或笔记先落盘，模型才能看到最新标记。
      if (PR.store.pending) throw new Error("笔记尚未保存，请等本地服务恢复后重试");
      for (const image of images) {
        const upload = await fetch("/api/p/" + PR.pid + "/chat-images?name=" + encodeURIComponent(image.name), {
          method: "POST", signal: ctrl.signal, headers: { "Content-Type": image.file.type, "X-Token": PR.token || "" }, body: image.file,
        });
        const data = await upload.json();
        if (!upload.ok) throw Error(data.error || "图片上传失败");
        attachments.push(data.image);
      }
      uploaded = true;
      if (attachments.length) user.images = attachments;
      const res = await fetch("/api/p/" + PR.pid + "/chat", {
        method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "X-Token": PR.token || "" },
        body: JSON.stringify({ thread: t.id, text, anchor: user.anchor, quote: user.quote, refs, note: noteId || null, model: st.model, images: attachments }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "HTTP " + res.status);
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.thread && !t.id) { t.id = ev.thread; st.cur = ev.thread; }
          if (ev.model) msg.model = ev.model;
          if (ev.t) { msg.content += ev.t; renderLiveSoon(); }
          if (ev.done) { msg.id = ev.id; msg.complete = true; }
          if (ev.save_task) msg.save_task = ev.save_task;
          if (ev.timing) msg.timing = ev.timing;
          if (ev.error) msg.error = ev.error;
        }
      }
    } catch (e) {
      if (e.name === "AbortError" && !uploaded) msg.error = "图片尚未发送，已停止";
      else if (e.name === "AbortError") msg.error = "已停止；部分输出未作为成功回答保存，重新提问可能再次收费";
      else msg.error = "没能回答：" + e.message;
    }
    if (!msg.complete && !msg.error) msg.error = "连接已结束，尚未确认完整保存；请重新打开对话核对，重新提问可能再次收费";
    st.streaming = null;
    if (msg.error && !only) {
      if (attachments.length) user.images = attachments; else delete user.images;
      st.images = images;
      const input = PR.$("#chatInput");
      if (input && !input.value) input.value = text;
      st.draft = input ? input.value : text;
    }
    else images.forEach((image) => URL.revokeObjectURL(image.preview));
    t.updated = PR.nowIso();
    if (noteId) { PR.asking.delete(noteId); setTimeout(() => PR.poll && PR.poll(), 300); }
    if (!only && !msg.error) { st.refs = []; st.noAuto = false; autoContext(); }  // 问完清掉引用，回到“正在读”
    render(true);
  }

  /* ---------- 事件 ---------- */
  document.addEventListener("click", async (e) => {
    if (!e.target.closest("#chatpanel")) return;
    const b = e.target.closest("[data-c]");
    if (!b) { if (st.menuOpen && !e.target.closest(".ch-menu")) { st.menuOpen = false; render(); } return; }
    const c = b.dataset.c;
    const row = b.closest(".ch-thread[data-t]");
    if (c === "save-answer") { try { await PR.api(("/api/p/" + PR.pid) + "/chat/save", {method:"POST",body:{task:b.dataset.task}}); await load(true); render(); } catch(error) {PR.toast(PR.esc(error.message));} return; }
    if (c === "close") return PR.toggleChat(false);
    if (c === "list") { st.listOpen = !st.listOpen; st.menuOpen = false; return render(); }
    if (c === "new") { if (st.streaming) return; st.cur = null; st.listOpen = false; st.model = st.def; st.refs = []; st.noAuto = false; autoContext(); render(); return focusInput(); }
    if (c === "menu") { st.menuOpen = !st.menuOpen; st.listOpen = false; return render(); }
    if (c === "model") { st.model = b.dataset.m; st.menuOpen = false; return render(); }
    if (c === "manage") { st.menuOpen = false; render(); return PR.openSettings("chat"); }
    if (c === "send") return send(PR.$("#chatInput").value);
    if (c === "add-image") return PR.$("#chatImageFile").click();
    if (c === "remove-image") { const removed = st.images.splice(+b.dataset.i, 1); removed.forEach((image) => URL.revokeObjectURL(image.preview)); return render(); }
    if (c === "stop" && st.streaming) return st.streaming.ctrl.abort();
    if (c === "suggest") return send(b.textContent);
    if (c === "unref") { st.refs.splice(+b.dataset.i, 1); return render(); }
    if (c === "noauto") { st.noAuto = true; return render(); }
    if (c === "go") return PR.jumpTo("b-" + b.dataset.anchor);
    if (c === "rename" && row) {
      const t = st.threads.find((x) => x.id === row.dataset.t);
      const title = await PR.promptText({ title: "对话改名", value: t.title, ok: "改名", at: row });
      if (title) { t.title = title; await PR.api("/api/p/" + PR.pid + "/chat/rename", { method: "POST", body: { thread: t.id, title: t.title } }); render(); }
      return;
    }
    if (c === "del" && row) {
      const t = st.threads.find((x) => x.id === row.dataset.t);
      if (!(await PR.confirm({ title: "删除这个对话？", body: "「" + t.title + "」。已经放到页边的讨论不受影响。", ok: "删除", danger: true, at: row }))) return;
      await PR.api("/api/p/" + PR.pid + "/chat/delete", { method: "POST", body: { thread: t.id } });
      st.threads = st.threads.filter((x) => x !== t);
      if (st.cur === t.id) st.cur = null;
      return render();
    }
    const card = b.closest(".cm.ai");
    const m = card && thread() && thread().messages.find((x) => x.id === card.dataset.id);
    if (c === "copy" && m) navigator.clipboard.writeText(m.content).then(() => PR.toast("已复制"));
    if (c === "pin" && m) {
      try {
        await PR.api("/api/p/" + PR.pid + "/chat/pin", { method: "POST", body: { thread: st.cur, id: m.id } });
        PR.toast(PR.noteSurface ? "已保存到笔记" : "已放到页边"); setTimeout(() => PR.poll && PR.poll(), 200);
      } catch (err) { PR.toast("没放成：" + PR.esc(err.message)); }
    }
  });
  document.addEventListener("click", (e) => {  // 点对话列表里的一行：切过去
    const row = e.target.closest("#chatpanel .ch-thread[data-t]");
    if (!row || e.target.closest("[data-c]")) return;
    st.cur = row.dataset.t; st.listOpen = false;
    const t = thread();
    if (t && t.model && st.models.some((m) => m.id === t.model)) st.model = t.model;
    render();
  });
  document.addEventListener("keydown", (e) => {
    if (e.target.id !== "chatInput") return;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(e.target.value); }
    if (e.key === "Escape") e.target.blur();
  });
  document.addEventListener("input", (e) => { if (e.target.id === "chatInput") PR.autosize(e.target); });
  panel().addEventListener("change", (e) => { if (e.target.id === "chatImageFile") addImages(Array.from(e.target.files || [])); });
  panel().addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.items || []).filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain"), input = PR.$("#chatInput");
    if (text && input) input.setRangeText(text, input.selectionStart, input.selectionEnd, "end");
    addImages(files);
  });
  /* 把正文里选中的文字拖进问 AI 面板：变成一段引用，而不是一堆粘进来的字 */
  let dragRef = null;
  PR.on("article-drag", (ref) => { dragRef = ref; if (ref && PR.chatOpen()) panel().classList.add("drop-ok"); else panel().classList.remove("drop-ok", "drop-on"); });
  document.addEventListener("dragstart", (e) => {
    const sel = window.getSelection();
    const node = sel && sel.rangeCount && sel.getRangeAt(0).startContainer;
    const host = node && (node.nodeType === 1 ? node : node.parentElement).closest("#paper [id^='b-']");
    dragRef = host ? { anchor: host.id.slice(2), quote: sel.toString().trim().slice(0, 1000) } : null;
    if (dragRef && PR.chatOpen()) panel().classList.add("drop-ok");
  });
  document.addEventListener("dragend", () => { dragRef = null; panel().classList.remove("drop-ok", "drop-on"); });
  panel().addEventListener("dragover", (e) => { if (!dragRef && !Array.from(e.dataTransfer.types || []).includes("Files")) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; panel().classList.add("drop-on"); });
  panel().addEventListener("dragleave", (e) => { if (!panel().contains(e.relatedTarget)) panel().classList.remove("drop-on"); });
  panel().addEventListener("drop", (e) => {
    const files = Array.from(e.dataTransfer?.files || []).filter((file) => file.type.startsWith("image/"));
    if (files.length) { e.preventDefault(); e.stopPropagation(); panel().classList.remove("drop-ok", "drop-on"); return addImages(files); }
    if (!dragRef) return;
    e.preventDefault();
    panel().classList.remove("drop-ok", "drop-on");
    const { anchor, quote } = dragRef;
    dragRef = null;
    addRef(anchor, quote);
    render(); focusInput();
  });
  /* 读到别处时，上下文跟着换成当前段（手动指定的不动） */
  const followReading = PR.debounce(() => {
    if (!PR.chatOpen() || st.streaming) return;
    const before = st.auto && st.auto.anchor;
    autoContext();
    if ((st.auto && st.auto.anchor) === before || st.refs.length || st.noAuto) return;
    const el = PR.$(".chip-ctx.auto > span");
    if (el && st.auto) { el.textContent = "正在读：" + ctxLabel(st.auto); el.parentElement.title = ctxLabel(st.auto); } else render();
  }, 400);
  window.addEventListener("scroll", followReading, { passive: true });
  PR.on("reading-context", followReading);
})(window.PR);
