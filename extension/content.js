(() => {
  let mounted = null;

  function currentIssue() {
    const match = /^\/[\w-]+\/[\w.-]+\/issues\/[1-9]\d{0,14}\/?$/.exec(location.pathname);
    return match ? location.origin + match[0].replace(/\/$/, "") : null;
  }

  function make(tag, value, className) {
    const element = document.createElement(tag);
    if (value !== undefined) element.textContent = value;
    if (className) element.className = className;
    return element;
  }

  function link(label, url) {
    const a = make("a", label);
    try {
      const target = new URL(url);
      if (target.origin === "https://github.com" && !target.username && !target.password) {
        a.href = target.href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
    } catch { /* Show an inert label for malformed links. */ }
    return a;
  }

  function section(title, children) {
    const group = make("section");
    group.append(make("h3", title), ...children);
    return group;
  }

  function items(list, ordered, build) {
    const node = make(ordered ? "ol" : "ul");
    for (const item of list) {
      const li = make("li");
      li.append(...build(item));
      node.append(li);
    }
    return node;
  }

  function refs(ids) { return make("small", ids.join(" · "), "refs"); }

  function resultNodes(result) {
    const nodes = [link(result.issue.title, result.issue.url), section("问题摘要", [make("p", result.summary)])];
    if (result.changes.length) nodes.push(section("本次变化", [items(result.changes, false,
      row => [make("span", row.description), refs(row.evidenceIds)])]));
    nodes.push(section("调查证据", [items(result.evidence, false, record => {
      const label = record.id + " · " + record.label;
      const source = record.url ? link(label, record.url) : make("strong", label);
      const excerpt = make("details");
      excerpt.append(make("summary", record.kind === "repo_excerpt" ? "查看源码片段" : "查看原文"), make("pre", record.excerpt || "（空）"));
      return [source, excerpt];
    })]));
    nodes.push(section("可能根因", [result.hypotheses.length ? items(result.hypotheses, true, row => [
      make("strong", (row.id ? row.id + " · " : "") + row.claim), make("p", row.howToCheck), refs(row.evidenceIds),
      ...(row.counterEvidenceIds?.length ? [make("small", "削弱此判断的证据 " + row.counterEvidenceIds.join(" · "))] : [])
    ]) : make("p", "现有信息不足以定位根因。")]));
    nodes.push(section("建议处理步骤", [items(result.steps, true, step => [
      make("strong", step.action), make("p", "验证方式：" + step.expectedObservation), refs(step.evidenceIds)
    ])]));
    nodes.push(section("待澄清信息", [result.clarifications.length ? items(result.clarifications, false,
      row => [make("strong", row.question), make("p", row.whyItMatters)]) : make("p", "暂无")]));
    return nodes;
  }

  function details(view, expanded) {
    const fold = make("details");
    fold.open = expanded;
    fold.append(make("summary", "调查范围与工具记录"));
    const result = view.result;
    if (result) {
      if (result.investigation) fold.append(make("p", `本轮仓库调用 ${result.investigation.repoCalls} 次，模型调用 ${result.investigation.modelCalls} 次。`));
      if (result.limitations.length) fold.append(section("分析限制", [items(result.limitations, false, v => [make("span", v)])]));
    }
    if (view.trace?.length) fold.append(section("本轮调用", [items(view.trace, true, t =>
      [make("code", t.tool), make("p", [t.purpose, t.outcome].filter(Boolean).join(" · "))])]));
    return fold;
  }

  function mount(url) {
    const host = make("div");
    host.id = "github-issue-advisor";
    const root = host.attachShadow({ mode: "open" });
    const css = make("link");
    css.rel = "stylesheet";
    css.href = chrome.runtime.getURL("panel.css");
    const launch = make("button", "生成处理建议", "launch");
    const panel = make("aside");
    panel.hidden = true;
    panel.setAttribute("aria-label", "Issue 处理建议");
    const top = make("header");
    const close = make("button", "收起");
    top.append(make("h2", "Issue 处理建议"), close);
    const status = make("div", "", "status");
    status.setAttribute("role", "status");
    const body = make("div", undefined, "body");
    const form = make("form");
    const input = make("textarea");
    input.id = "issue-advisor-context";
    input.maxLength = 2000;
    input.rows = 2;
    const label = make("label", "补充背景");
    label.htmlFor = input.id;
    const submit = make("button", "更新建议", "primary");
    submit.type = "submit";
    const retry = make("button", "重试");
    retry.type = "button";
    const restart = make("button", "重新分析");
    restart.type = "button";
    form.append(label, input, submit);
    const footer = make("footer");
    footer.append(form, retry, restart);
    panel.append(top, status, body, footer);
    root.append(css, launch, panel);
    document.documentElement.append(host);

    let view = null, error = null, busy = false, timer = 0, generation = 0;
    const active = () => host.isConnected && currentIssue() === url;
    function paint() {
      const working = busy || view?.status === "running";
      const failure = error || (!busy && view?.error);
      const result = view?.result;
      launch.hidden = !panel.hidden;
      launch.textContent = view ? "查看处理建议" : "生成处理建议";
      status.textContent = failure ? failure.message : working ? "正在分析 Issue…" :
        result ? `第 ${view.revision} 版` : "准备读取 Issue";
      status.classList.toggle("error", Boolean(failure));
      const expanded = body.querySelector("details")?.open || false;
      body.replaceChildren(...(result ? resultNodes(result) : []));
      if (result || view?.trace?.length) body.append(details(view, expanded));
      form.hidden = !result;
      input.disabled = Boolean(working);
      submit.disabled = Boolean(working) || !input.value.trim();
      retry.hidden = !(failure && (!result || error));
      restart.hidden = !result || Boolean(working);
    }

    async function request(type, extra = {}) {
      clearTimeout(timer);
      const token = ++generation;
      busy = true;
      error = null;
      paint();
      try {
        const reply = await chrome.runtime.sendMessage({ url, type, ...extra });
        if (!active() || token !== generation) return;
        if (!reply || reply.error) throw reply?.error || { message: "扩展连接已中断，请刷新页面。" };
        view = reply.view;
        if (type === "update" && view?.status !== "failed") input.value = "";
        if (view?.pendingContext && !input.value) {
          input.value = view.pendingContext;
          lastSubmission = view.pendingContext;
        }
        if (view?.status === "ready" && type === "read" && input.value === lastSubmission &&
            view.result.evidence.some(item => item.kind === "user_context" && item.excerpt === lastSubmission)) input.value = "";
        if (view && type === "read" && restoring) panel.hidden = false;
      } catch (e) {
        if (!active() || token !== generation) return;
        error = { message: e.message || "请求失败，请重试。", code: e.code };
        if (e.code === "session_expired") view = null;
        if (e.code === "stale_revision") timer = setTimeout(() => request("read"), 300);
        if (e.code === "session_expired" && restoring) panel.hidden = false;
      } finally {
        if (active() && token === generation) {
          busy = false;
          restoring = false;
          paint();
          if (!error && view?.status === "running" && !panel.hidden) timer = setTimeout(() => request("read"), 900);
        }
      }
    }

    let restoring = true, lastSubmission = "";
    launch.onclick = event => {
      if (!event.isTrusted || !active()) return;
      panel.hidden = false;
      restoring = false;
      request(view ? "read" : "start");
    };
    close.onclick = () => { panel.hidden = true; restoring = false; clearTimeout(timer); paint(); launch.focus(); };
    retry.onclick = event => {
      if (event.isTrusted) request(view?.revision ? "read" : "start", { restart: view?.status === "failed" });
    };
    restart.onclick = event => {
      if (!event.isTrusted || busy || !active()) return;
      input.value = "";
      lastSubmission = "";
      request("start", { restart: true });
    };
    input.oninput = () => { submit.disabled = !input.value.trim() || busy || view?.status === "running"; };
    form.onsubmit = event => {
      event.preventDefault();
      if (!event.isTrusted || busy || !active() || !view?.revision || !input.value.trim()) return;
      lastSubmission = input.value.trim();
      request("update", { text: lastSubmission, baseRevision: view.revision });
    };
    paint();
    request("read");
    return { url, host, dispose: () => { ++generation; clearTimeout(timer); host.remove(); } };
  }

  function sync() {
    const url = currentIssue();
    if (mounted?.url === url && mounted.host.isConnected) return;
    mounted?.dispose();
    mounted = url ? mount(url) : null;
  }
  // GitHub uses same-document navigation, including when entering from a non-Issue page.
  window.navigation?.addEventListener("currententrychange", sync);
  window.addEventListener("popstate", sync);
  document.addEventListener("turbo:load", sync);
  sync();
})();
