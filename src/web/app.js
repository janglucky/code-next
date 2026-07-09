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
const desktopSidebarOpen = document.querySelector("#desktopSidebarOpen");
const mobileMenu = document.querySelector("#mobileMenu");
const historyList = document.querySelector("#historyList");
const sidebarConfig = document.querySelector("#sidebarConfig");
const sidebarSettings = document.querySelector("#sidebarSettings");
const topbarSettings = document.querySelector("#topbarSettings");
const settingsSurface = document.querySelector("#settingsSurface");
const settingsBack = document.querySelector("#settingsBack");
const settingsForm = document.querySelector("#settingsForm");
const settingsReset = document.querySelector("#settingsReset");
const settingsTabs = document.querySelectorAll("[data-settings-tab]");
const settingsPanels = document.querySelectorAll("[data-settings-panel]");
const settingsPageTitle = document.querySelector("#settingsPageTitle");
const workspaceInput = document.querySelector("#workspaceInput");
const workspaceBrowse = document.querySelector("#workspaceBrowse");
const workspaceHint = document.querySelector("#workspaceHint");
const settingsError = document.querySelector("#settingsError");
const stateFileValue = document.querySelector("#stateFileValue");
const settingsConfigDetails = document.querySelector("#settingsConfigDetails");
const configDialog = document.querySelector("#configDialog");
const configClose = document.querySelector("#configClose");
const configDetails = document.querySelector("#configDetails");
const configRefresh = document.querySelector("#configRefresh");

const MAX_CONVERSATIONS = 80;
const MAX_STORED_OUTPUT_CHARS = 4000;

let running = false;
let activeConversationId = null;
let conversations = [];
let appSettings = {
  defaults: {
    workspaceRoot: "",
  },
  stateFile: "",
  workspaceRoot: "",
};
let currentStatus = null;

function getDefaultWorkspaceRoot() {
  return appSettings.workspaceRoot || appSettings.defaults.workspaceRoot || "";
}

function normalizeWorkspaceRoot(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function getConversationWorkspaceRoot(conversation = getConversation()) {
  return normalizeWorkspaceRoot(conversation?.workspaceRoot, getDefaultWorkspaceRoot());
}

function workspaceLabel(value) {
  const normalized = normalizeWorkspaceRoot(value, "");

  if (!normalized) {
    return "未设置";
  }

  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  return segments.at(-1) || normalized;
}

function updateConfigSummary() {
  if (!currentStatus) {
    return;
  }

  configSummary.textContent = `${currentStatus.apiMode} · ${currentStatus.proxy} · ${workspaceLabel(
    getConversationWorkspaceRoot(),
  )}`;
}

function renderVisibleConfigDetails() {
  renderConfigDetails(configDetails);
  renderConfigDetails(settingsConfigDetails);
}

function setRunning(next) {
  running = next;
  sendButton.disabled = next;
  promptInput.disabled = next;
  sendButton.title = next ? "运行中" : "发送";
  renderHistory();
}

function resizeInput() {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 170)}px`;
}

function scrollToBottom() {
  messages.scrollTop = messages.scrollHeight;
}

function normalizeConversations(value, fallbackWorkspaceRoot = "") {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => item && typeof item === "object" && typeof item.id === "string")
    .map((item) => {
      const messages = Array.isArray(item.messages) ? item.messages : [];
      const inferredWorkspaceRoot = extractWorkspaceRootFromMessages(messages);

      return {
        id: item.id,
        title: typeof item.title === "string" && item.title.trim() ? item.title : "未命名任务",
        createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString(),
        workspaceRoot: normalizeWorkspaceRoot(item.workspaceRoot, inferredWorkspaceRoot || fallbackWorkspaceRoot),
        messages,
      };
    })
    .slice(0, MAX_CONVERSATIONS);
}

async function loadAppState() {
  try {
    const response = await fetch("/api/state");
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || response.statusText);
    }

    const defaultWorkspaceRoot = payload.defaults?.workspaceRoot || "";
    const settingsWorkspaceRoot = payload.settings?.workspaceRoot || defaultWorkspaceRoot;
    conversations = normalizeConversations(payload.conversations, settingsWorkspaceRoot);
    appSettings = {
      defaults: {
        workspaceRoot: defaultWorkspaceRoot,
      },
      stateFile: payload.stateFile || "",
      workspaceRoot: settingsWorkspaceRoot,
    };

    workspaceInput.value = appSettings.workspaceRoot;
    workspaceHint.textContent = `Agent 的文件扫描、读写和命令执行都会从此目录开始。状态文件：${appSettings.stateFile}`;
    stateFileValue.textContent = appSettings.stateFile || "未读取";
    updateConfigSummary();
    renderVisibleConfigDetails();
    renderHistory();
  } catch (error) {
    historyList.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = error instanceof Error ? error.message : String(error);
    historyList.append(empty);
  }
}

function saveConversations() {
  const sorted = [...conversations]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, MAX_CONVERSATIONS);
  conversations = sorted;
  void persistConversations();
}

async function persistConversations() {
  try {
    const response = await fetch("/api/conversations", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ conversations }),
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || response.statusText);
    }
  } catch (error) {
    console.error(error);
  }
}

function createConversationId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getConversation(id = activeConversationId) {
  return conversations.find((conversation) => conversation.id === id) || null;
}

function titleFromTask(task) {
  const firstLine = task.replace(/\s+/g, " ").trim();
  return firstLine.length > 28 ? `${firstLine.slice(0, 28)}...` : firstLine || "新任务";
}

function createConversation(task) {
  const now = new Date().toISOString();
  const conversation = {
    id: createConversationId(),
    title: titleFromTask(task),
    createdAt: now,
    updatedAt: now,
    workspaceRoot: getDefaultWorkspaceRoot(),
    messages: [],
  };

  conversations.unshift(conversation);
  activeConversationId = conversation.id;
  return conversation;
}

function ensureConversation(task) {
  const current = getConversation();

  if (current) {
    current.updatedAt = new Date().toISOString();
    current.workspaceRoot = getConversationWorkspaceRoot(current);
    return current;
  }

  return createConversation(task);
}

function clearConversationView() {
  messages.replaceChildren();
  chatSurface.classList.add("empty");
}

function renderConversation(conversation) {
  clearConversationView();

  if (!conversation || conversation.messages.length === 0) {
    return;
  }

  for (const record of conversation.messages) {
    const rendered = createMessage(record.role === "user" ? "user" : "assistant", String(record.content || ""));
    rendered.meta.textContent = typeof record.meta === "string" ? record.meta : "";

    if (record.role === "assistant" && Array.isArray(record.steps) && record.steps.length > 0) {
      const stepPanel = createStepPanel();
      rendered.body.insertBefore(stepPanel.panel, rendered.contentNode);

      for (const step of record.steps) {
        addStep(stepPanel.list, step);
      }

      if (record.stepsCollapsed !== false) {
        collapseStepPanel(stepPanel.panel, stepPanel.toggle);
      }
    }
  }

  scrollToBottom();
}

function startNewConversation() {
  activeConversationId = null;
  showChat();
  clearConversationView();
  promptInput.value = "";
  resizeInput();
  promptInput.focus();
  document.body.classList.remove("sidebar-open");
  updateConfigSummary();
  renderVisibleConfigDetails();
  renderHistory();
}

function showChat() {
  settingsSurface.hidden = true;
  chatSurface.hidden = false;
  document.body.classList.remove("settings-mode");
}

function showSettings(panel = "general") {
  chatSurface.hidden = true;
  settingsSurface.hidden = false;
  document.body.classList.add("settings-mode");
  selectSettingsPanel(panel);
  document.body.classList.remove("sidebar-open");
}

function selectSettingsPanel(panel) {
  const activeTab = [...settingsTabs].find((tab) => tab.dataset.settingsTab === panel);
  const activePanel = [...settingsPanels].find((item) => item.dataset.settingsPanel === panel);

  if (!activeTab || !activePanel) {
    return;
  }

  settingsTabs.forEach((tab) => {
    tab.classList.toggle("active", tab === activeTab);
  });
  settingsPanels.forEach((item) => {
    item.classList.toggle("active", item === activePanel);
  });
  settingsPageTitle.textContent = activeTab.textContent || "设置";

  if (panel === "config") {
    renderConfigDetails(settingsConfigDetails);
  }
}

function formatHistoryDate(value) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const dateKey = date.toDateString();

  if (dateKey === today.toDateString()) {
    return "今天";
  }

  if (dateKey === yesterday.toDateString()) {
    return "昨天";
  }

  return date.toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  });
}

function deleteConversation(id) {
  conversations = conversations.filter((conversation) => conversation.id !== id);

  if (activeConversationId === id) {
    activeConversationId = null;
    clearConversationView();
    updateConfigSummary();
    renderVisibleConfigDetails();
  }

  saveConversations();
  renderHistory();
}

function renderHistory() {
  historyList.replaceChildren();

  if (conversations.length === 0) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "暂无历史任务";
    historyList.append(empty);
    return;
  }

  let lastGroup = "";

  for (const conversation of conversations) {
    const group = formatHistoryDate(conversation.updatedAt);

    if (group !== lastGroup) {
      const label = document.createElement("p");
      label.className = "history-date-label";
      label.textContent = group;
      historyList.append(label);
      lastGroup = group;
    }

    const row = document.createElement("div");
    row.className = `history-row${conversation.id === activeConversationId ? " active" : ""}`;

    const item = document.createElement("button");
    item.className = "history-item";
    item.type = "button";
    item.textContent = conversation.title;
    item.title = conversation.title;
    item.addEventListener("click", () => {
      activeConversationId = conversation.id;
      conversation.workspaceRoot = getConversationWorkspaceRoot(conversation);
      showChat();
      renderConversation(conversation);
      updateConfigSummary();
      renderVisibleConfigDetails();
      renderHistory();
      document.body.classList.remove("sidebar-open");
    });

    const remove = document.createElement("button");
    remove.className = "history-delete";
    remove.type = "button";
    remove.title = "删除对话";
    remove.setAttribute("aria-label", `删除 ${conversation.title}`);
    remove.disabled = running && conversation.id === activeConversationId;
    remove.innerHTML = [
      '<svg viewBox="0 0 24 24" aria-hidden="true">',
      '<path d="M4 7h16" />',
      '<path d="M10 11v6M14 11v6" />',
      '<path d="M6 7l1 13h10l1-13" />',
      '<path d="M9 7V4h6v3" />',
      "</svg>",
    ].join("");
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteConversation(conversation.id);
    });

    row.append(item, remove);
    historyList.append(row);
  }
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

function normalizeStepForStorage(event) {
  if (event.type === "model") {
    return {
      type: "model",
      step: event.step,
      thought: event.thought || "",
      action: event.action || null,
    };
  }

  const step = {
    type: "tool",
    step: event.step,
    tool: event.tool,
    ok: Boolean(event.ok),
    output: truncate(String(event.output || ""), MAX_STORED_OUTPUT_CHARS),
  };

  if (typeof event.workspaceRoot === "string" && event.workspaceRoot.trim()) {
    step.workspaceRoot = event.workspaceRoot.trim();
  }

  return step;
}

function extractWorkspaceRootFromOutput(output) {
  const match = String(output || "").match(/^Workspace changed to\s+(.+)$/);
  return match ? match[1].trim() : "";
}

function extractWorkspaceRootFromMessages(messageRecords) {
  let workspaceRoot = "";

  for (const message of messageRecords) {
    const steps = Array.isArray(message?.steps) ? message.steps : [];

    for (const step of steps) {
      if (step?.type !== "tool" || step.tool !== "change_workdir" || !step.ok) {
        continue;
      }

      workspaceRoot =
        normalizeWorkspaceRoot(step.workspaceRoot, "") || normalizeWorkspaceRoot(extractWorkspaceRootFromOutput(step.output), "");
    }
  }

  return workspaceRoot;
}

function applyWorkspaceRootFromStep(conversation, step) {
  if (step.type !== "tool" || step.tool !== "change_workdir" || !step.ok) {
    return false;
  }

  const nextWorkspaceRoot =
    normalizeWorkspaceRoot(step.workspaceRoot, "") || normalizeWorkspaceRoot(extractWorkspaceRootFromOutput(step.output), "");

  if (!nextWorkspaceRoot) {
    return false;
  }

  conversation.workspaceRoot = nextWorkspaceRoot;
  return true;
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
  const conversation = ensureConversation(task);
  const now = new Date().toISOString();
  const workspaceRoot = getConversationWorkspaceRoot(conversation);

  conversation.updatedAt = now;
  conversation.workspaceRoot = workspaceRoot;
  conversation.messages.push({
    role: "user",
    content: task,
  });

  const assistantRecord = {
    role: "assistant",
    content: "正在思考...",
    meta: "正在连接 Agent",
    steps: [],
    stepsCollapsed: false,
  };

  conversation.messages.push(assistantRecord);
  saveConversations();
  renderHistory();

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
      body: JSON.stringify({ task, workspaceRoot }),
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
          if (typeof event.workspaceRoot === "string" && event.workspaceRoot.trim()) {
            conversation.workspaceRoot = event.workspaceRoot.trim();
            renderVisibleConfigDetails();
            updateConfigSummary();
          }
          assistant.meta.textContent = `${event.model} · 最多 ${event.maxSteps} 步`;
          assistantRecord.meta = assistant.meta.textContent;
          saveConversations();
          continue;
        }

        if (event.type === "model" || event.type === "tool") {
          const storedStep = normalizeStepForStorage(event);
          const workspaceChanged = applyWorkspaceRootFromStep(conversation, storedStep);
          assistantRecord.steps.push(storedStep);
          addStep(stepPanel.list, storedStep);
          conversation.updatedAt = new Date().toISOString();
          if (workspaceChanged) {
            renderVisibleConfigDetails();
            updateConfigSummary();
          }
          saveConversations();
          continue;
        }

        if (event.type === "final") {
          renderMarkdown(assistant.contentNode, event.final);
          assistant.meta.textContent = `完成 · ${event.steps} 步`;
          collapseStepPanel(stepPanel.panel, stepPanel.toggle);
          assistantRecord.content = event.final;
          assistantRecord.meta = assistant.meta.textContent;
          assistantRecord.stepsCollapsed = true;
          conversation.updatedAt = new Date().toISOString();
          saveConversations();
          renderHistory();
          continue;
        }

        if (event.type === "error") {
          renderMarkdown(assistant.contentNode, event.error);
          assistant.meta.textContent = "运行失败";
          assistantRecord.content = event.error;
          assistantRecord.meta = "运行失败";
          assistantRecord.stepsCollapsed = false;
          conversation.updatedAt = new Date().toISOString();
          saveConversations();
          renderHistory();
          statusPill.textContent = "运行失败";
          statusPill.className = "status-pill error";
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    renderMarkdown(assistant.contentNode, message);
    assistant.meta.textContent = "运行失败";
    assistantRecord.content = message;
    assistantRecord.meta = "运行失败";
    assistantRecord.stepsCollapsed = false;
    conversation.updatedAt = new Date().toISOString();
    saveConversations();
    renderHistory();
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

    currentStatus = status;
    statusPill.textContent = `${status.provider} · ${status.model}`;
    statusPill.className = "status-pill ready";
    configTitle.textContent = "配置就绪";
    appSettings.workspaceRoot = status.workspaceRoot || appSettings.workspaceRoot;
    workspaceInput.value = appSettings.workspaceRoot;
    updateConfigSummary();
    renderConfigDetails(settingsConfigDetails);
  } catch (error) {
    statusPill.textContent = "配置缺失";
    statusPill.className = "status-pill error";
    configTitle.textContent = "需要配置";
    configSummary.textContent = error instanceof Error ? error.message : String(error);
  }
}

function renderConfigDetails(target = configDetails) {
  target.replaceChildren();

  const rows = [
    ["当前模型", currentStatus?.model || "未读取"],
    ["Provider", currentStatus?.provider || "未读取"],
    ["API 模式", currentStatus?.apiMode || "未读取"],
    ["默认工作目录", currentStatus?.workspaceRoot || appSettings.workspaceRoot || "未设置"],
    ["当前会话目录", getConversationWorkspaceRoot() || "未设置"],
    ["代理", currentStatus?.proxy || "未读取"],
    ["最大步数", currentStatus?.maxSteps ? String(currentStatus.maxSteps) : "未读取"],
    ["状态文件", appSettings.stateFile || "未读取"],
  ];

  for (const [labelText, valueText] of rows) {
    const row = document.createElement("div");
    row.className = "config-detail-row";

    const label = document.createElement("span");
    label.textContent = labelText;

    const value = document.createElement("strong");
    value.textContent = valueText;

    row.append(label, value);
    target.append(row);
  }
}

async function openConfig() {
  configDialog.hidden = false;
  renderConfigDetails();
  await updateStatus();
  renderConfigDetails();
}

function closeConfig() {
  configDialog.hidden = true;
}

function openSettings() {
  workspaceInput.value = appSettings.workspaceRoot || appSettings.defaults.workspaceRoot || "";
  settingsError.textContent = "";
  showSettings("general");
  workspaceInput.focus();
  workspaceInput.select();
}

async function saveSettings(workspaceRoot) {
  settingsError.textContent = "";

  try {
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceRoot }),
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || response.statusText);
    }

    appSettings.workspaceRoot = payload.settings.workspaceRoot;
    workspaceInput.value = appSettings.workspaceRoot;
    stateFileValue.textContent = appSettings.stateFile || "未读取";
    await updateStatus();
  } catch (error) {
    settingsError.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function selectDirectoryFromServer(initialPath) {
  const response = await fetch("/api/select-directory", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ initialPath }),
  });
  const payload = await response.json();

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || response.statusText);
  }

  return payload.canceled ? null : payload.path;
}

async function browseWorkspaceRoot() {
  settingsError.textContent = "";
  workspaceBrowse.disabled = true;

  try {
    const initialPath = workspaceInput.value || getDefaultWorkspaceRoot();
    const desktop = globalThis.codeAgentDesktop;
    const selectedPath =
      desktop && typeof desktop.selectDirectory === "function"
        ? await desktop.selectDirectory(initialPath)
        : await selectDirectoryFromServer(initialPath);

    if (!selectedPath) {
      return;
    }

    workspaceInput.value = selectedPath;
    await saveSettings(selectedPath);
  } catch (error) {
    settingsError.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    workspaceBrowse.disabled = false;
    workspaceInput.focus();
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
  startNewConversation();
});

sidebarToggle.addEventListener("click", () => {
  if (window.matchMedia("(max-width: 860px)").matches) {
    document.body.classList.remove("sidebar-open");
    return;
  }

  document.body.classList.toggle("sidebar-collapsed");
});

desktopSidebarOpen.addEventListener("click", () => {
  document.body.classList.remove("sidebar-collapsed");
});

mobileMenu.addEventListener("click", () => {
  document.body.classList.add("sidebar-open");
});

sidebarConfig.addEventListener("click", () => {
  void openConfig();
});
sidebarSettings.addEventListener("click", openSettings);
topbarSettings.addEventListener("click", openSettings);
settingsBack.addEventListener("click", () => {
  showChat();
});
settingsTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    selectSettingsPanel(tab.dataset.settingsTab);
  });
});
settingsReset.addEventListener("click", () => {
  workspaceInput.value = appSettings.defaults.workspaceRoot || "";
  workspaceInput.focus();
});
workspaceBrowse.addEventListener("click", () => {
  void browseWorkspaceRoot();
});
settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveSettings(workspaceInput.value);
});
configClose.addEventListener("click", closeConfig);
configDialog.addEventListener("click", (event) => {
  if (event.target === configDialog) {
    closeConfig();
  }
});
configRefresh.addEventListener("click", () => {
  void openConfig();
});

refreshStatus.addEventListener("click", () => {
  void updateStatus();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !settingsSurface.hidden) {
    showChat();
  }

  if (event.key === "Escape" && !configDialog.hidden) {
    closeConfig();
  }
});

window.addEventListener("resize", resizeInput);

resizeInput();
void loadAppState();
void updateStatus();
