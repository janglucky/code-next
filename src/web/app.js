const chatSurface = document.querySelector("#chatSurface");
const messages = document.querySelector("#messages");
const composer = document.querySelector("#composer");
const promptInput = document.querySelector("#promptInput");
const sendButton = document.querySelector("#sendButton");
const newChatButton = document.querySelector("#newChat");
const statusPill = document.querySelector("#statusPill");
const configTitle = document.querySelector("#configTitle");
const configSummary = document.querySelector("#configSummary");
const refreshStatus = document.querySelector("#refreshStatus");
const sidebarToggle = document.querySelector("#sidebarToggle");
const mobileMenu = document.querySelector("#mobileMenu");

let running = false;

function setRunning(next) {
  running = next;
  sendButton.disabled = next;
  promptInput.disabled = next;
  sendButton.title = next ? "运行中" : "发送";
}

function resizeInput() {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 170)}px`;
}

function scrollToBottom() {
  messages.scrollTop = messages.scrollHeight;
}

function createMessage(role, content) {
  chatSurface.classList.remove("empty");

  const message = document.createElement("article");
  message.className = `message ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "你" : "A";

  const body = document.createElement("div");
  body.className = "message-body";

  const contentNode = document.createElement("div");
  contentNode.className = "message-content";
  renderMarkdown(contentNode, content);

  const meta = document.createElement("div");
  meta.className = "message-meta";

  body.append(contentNode, meta);
  message.append(avatar, body);
  messages.append(message);
  scrollToBottom();

  return { message, body, contentNode, meta };
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInlineMarkdown(value) {
  let html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return html;
}

function renderMarkdown(target, markdown) {
  const source = String(markdown || "").trim();

  if (!source) {
    target.textContent = "";
    return;
  }

  const blocks = source.split(/(```[\s\S]*?```)/g);
  const html = blocks
    .map((block) => {
      const fence = block.match(/^```(\w+)?\n?([\s\S]*?)```$/);

      if (fence) {
        const lang = fence[1] ? ` data-lang="${escapeHtml(fence[1])}"` : "";
        return `<pre class="markdown-code"${lang}><code>${escapeHtml(fence[2].trim())}</code></pre>`;
      }

      return block
        .split(/\n{2,}/)
        .map((paragraph) => {
          const lines = paragraph.split("\n");

          if (lines.every((line) => /^[-*]\s+/.test(line.trim()))) {
            const items = lines
              .map((line) => `<li>${renderInlineMarkdown(line.trim().replace(/^[-*]\s+/, ""))}</li>`)
              .join("");
            return `<ul>${items}</ul>`;
          }

          const heading = paragraph.match(/^(#{1,3})\s+(.+)$/);
          if (heading) {
            const level = heading[1].length + 2;
            return `<h${level}>${renderInlineMarkdown(heading[2].trim())}</h${level}>`;
          }

          return `<p>${lines.map((line) => renderInlineMarkdown(line)).join("<br>")}</p>`;
        })
        .join("");
    })
    .join("");

  target.innerHTML = html;
}

function truncate(value, maxLength = 1400) {
  if (!value || value.length <= maxLength) {
    return value || "";
  }

  return `${value.slice(0, maxLength)}\n... 已截断 ${value.length - maxLength} 个字符`;
}

function summarizeObservation(output) {
  const value = String(output || "").replace(/\s+/g, " ").trim();
  return value || "无输出";
}

function createStepPanel() {
  const panel = document.createElement("section");
  panel.className = "steps";

  const toggle = document.createElement("button");
  toggle.className = "steps-toggle";
  toggle.type = "button";
  toggle.textContent = "收起执行步骤";

  const list = document.createElement("div");
  list.className = "steps-list";

  toggle.addEventListener("click", () => {
    const collapsed = panel.classList.toggle("collapsed");
    toggle.textContent = collapsed ? "展开执行步骤" : "收起执行步骤";
  });

  panel.append(toggle, list);

  return { panel, list, toggle };
}

function collapseStepPanel(panel, toggle) {
  panel.classList.add("collapsed");
  toggle.textContent = "展开执行步骤";
}

function addStep(steps, event) {
  if (event.type === "model") {
    const item = document.createElement("section");
    item.className = "step-item model-step";

    const markdown = [
      `**步骤 ${event.step}${event.action ? ` · 调用 \`${event.action.tool}\`` : " · 模型思考"}**`,
      event.thought || "",
      event.action ? `\`\`\`json\n${JSON.stringify(event.action.input ?? {}, null, 2)}\n\`\`\`` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    renderMarkdown(item, markdown);
    steps.append(item);
    scrollToBottom();
    return;
  }

  if (event.type === "tool") {
    const item = document.createElement("section");
    item.className = "step-item observation-step";

    const summary = document.createElement("div");
    summary.className = "observation-summary";

    const label = document.createElement("span");
    label.className = "observation-label";
    label.textContent = `观察 ${event.step} · ${event.tool}${event.ok ? " 完成" : " 失败"}`;

    const preview = document.createElement("span");
    preview.className = "observation-preview";
    preview.textContent = summarizeObservation(event.output);

    const toggle = document.createElement("button");
    toggle.className = "observation-toggle";
    toggle.type = "button";
    toggle.textContent = "展开";

    const detail = document.createElement("pre");
    detail.className = "observation-detail";
    detail.textContent = truncate(event.output);

    toggle.addEventListener("click", () => {
      const expanded = item.classList.toggle("expanded");
      toggle.textContent = expanded ? "收起" : "展开";
    });

    summary.append(label, preview, toggle);
    item.append(summary, detail);
    steps.append(item);
    scrollToBottom();
  }
}

async function readJsonError(response) {
  try {
    const payload = await response.json();
    return payload.error || response.statusText;
  } catch {
    return response.statusText;
  }
}

async function runTask(task) {
  createMessage("user", task);
  const assistant = createMessage("assistant", "正在思考...");
  const stepPanel = createStepPanel();
  assistant.body.insertBefore(stepPanel.panel, assistant.contentNode);
  assistant.meta.textContent = "正在连接 Agent";

  setRunning(true);

  try {
    const response = await fetch("/api/run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ task }),
    });

    if (!response.ok || !response.body) {
      throw new Error(await readJsonError(response));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        const event = JSON.parse(line);

        if (event.type === "config") {
          assistant.meta.textContent = `${event.model} · 最多 ${event.maxSteps} 步`;
          continue;
        }

        if (event.type === "model" || event.type === "tool") {
          addStep(stepPanel.list, event);
          continue;
        }

        if (event.type === "final") {
          renderMarkdown(assistant.contentNode, event.final);
          assistant.meta.textContent = `完成 · ${event.steps} 步`;
          collapseStepPanel(stepPanel.panel, stepPanel.toggle);
          continue;
        }

        if (event.type === "error") {
          renderMarkdown(assistant.contentNode, event.error);
          assistant.meta.textContent = "运行失败";
          statusPill.textContent = "运行失败";
          statusPill.className = "status-pill error";
        }
      }
    }
  } catch (error) {
    renderMarkdown(assistant.contentNode, error instanceof Error ? error.message : String(error));
    assistant.meta.textContent = "运行失败";
    statusPill.textContent = "运行失败";
    statusPill.className = "status-pill error";
  } finally {
    setRunning(false);
    promptInput.focus();
    scrollToBottom();
  }
}

async function updateStatus() {
  statusPill.textContent = "连接中";
  statusPill.className = "status-pill";
  configSummary.textContent = "正在读取配置";

  try {
    const response = await fetch("/api/status");
    const status = await response.json();

    if (!response.ok || !status.ok) {
      throw new Error(status.error || response.statusText);
    }

    statusPill.textContent = `${status.provider} · ${status.model}`;
    statusPill.className = "status-pill ready";
    configTitle.textContent = "配置就绪";
    configSummary.textContent = `${status.apiMode} · ${status.proxy} · ${status.workspace}`;
  } catch (error) {
    statusPill.textContent = "配置缺失";
    statusPill.className = "status-pill error";
    configTitle.textContent = "需要配置";
    configSummary.textContent = error instanceof Error ? error.message : String(error);
  }
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const task = promptInput.value.trim();

  if (!task || running) {
    return;
  }

  promptInput.value = "";
  resizeInput();
  void runTask(task);
});

promptInput.addEventListener("input", resizeInput);
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

document.querySelectorAll(".quick-actions button").forEach((button) => {
  button.addEventListener("click", () => {
    promptInput.value = button.textContent || "";
    resizeInput();
    promptInput.focus();
  });
});

newChatButton.addEventListener("click", () => {
  messages.replaceChildren();
  chatSurface.classList.add("empty");
  promptInput.value = "";
  resizeInput();
  promptInput.focus();
  document.body.classList.remove("sidebar-open");
});

sidebarToggle.addEventListener("click", () => {
  if (window.matchMedia("(max-width: 860px)").matches) {
    document.body.classList.remove("sidebar-open");
    return;
  }

  document.body.classList.toggle("sidebar-collapsed");
});

mobileMenu.addEventListener("click", () => {
  document.body.classList.add("sidebar-open");
});

refreshStatus.addEventListener("click", () => {
  void updateStatus();
});

window.addEventListener("resize", resizeInput);

resizeInput();
void updateStatus();
