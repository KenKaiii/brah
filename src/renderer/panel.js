const tabs = Object.freeze([
  { id: "tasks", label: "Tasks", category: "tasks" },
  { id: "calendar", label: "Calendar", category: "calendar" },
  { id: "screenshots", label: "Shots", category: "screenshots" },
  { id: "memory", label: "Memory", category: "memory" },
  { id: "computer", label: "Computer", category: "computer" },
]);

// Sub-tabs shown inside the Memory tab. "facts" maps to the facts store, "soul"
// to the working-relationship notes, and "daily" to the daily logs store; each
// refreshes on its own data category. `editKind` is the memory:update kind.
// Where each fact came from (facts.source), shown beside its date.
const factSourceLabels = Object.freeze({
  conversation: "picked up in conversation",
  voice: "you asked to remember",
  you: "edited by you",
});

const memorySubTabs = Object.freeze([
  { id: "facts", label: "Facts", category: "memory", editKind: "fact" },
  { id: "soul", label: "Working notes", category: "soul", editKind: "soul" },
  { id: "daily", label: "Daily logs", category: "daily", editKind: "daily" },
]);

const MAX_ACTIVITY_ITEMS = 20;

const statusOrder = Object.freeze(["in_progress", "todo", "completed"]);
const statusLabels = Object.freeze({
  todo: "To do",
  in_progress: "In progress",
  completed: "Completed",
});

// Readable labels for computer-use run results (raw values come from the tool).
const computerRunStatusLabels = Object.freeze({
  completed: "Done",
  error: "Failed",
  max_steps: "Step limit",
  cancelled: "Stopped",
  permission_required: "Needs permission",
  invalid_arguments: "Invalid request",
});

export function createPanelController({ brah, onModeChange } = {}) {
  const bridge = brah ?? window.brah;
  const panelElement = document.querySelector("#panel");
  const tabsElement = document.querySelector("#panel-tabs");
  const subTabsElement = document.querySelector("#panel-subtabs");
  const bodyElement = document.querySelector("#panel-body");
  const footerElement = document.querySelector("#panel-footer-text");

  let isOpen = false;
  let activeTabId = tabs[0].id;
  let activeMemorySubTabId = memorySubTabs[0].id;
  let dataChangedListener = null;
  let selectionBar = null;
  let selectionCountElement = null;
  let selectionDoneButton = null;
  let selectionEditButton = null;
  let animateNextRender = true;
  const selectedIds = new Set();
  // Row id -> editable text for the memory entries currently rendered.
  const editableText = new Map();

  // Tabs whose items support multi-select + delete. The Memory tab is selectable
  // through any of its sub-tabs (facts, working notes, or daily logs).
  const selectableTabs = Object.freeze(new Set(["tasks", "calendar", "screenshots", "memory"]));

  function renderTabs() {
    // Drives the sliding thumb in styles.css (.panel-tabs::before).
    tabsElement.style.setProperty("--tab-count", String(tabs.length));
    tabsElement.style.setProperty(
      "--tab-index",
      String(
        Math.max(
          0,
          tabs.findIndex((tab) => tab.id === activeTabId),
        ),
      ),
    );
    tabsElement.replaceChildren(
      ...tabs.map((tab) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `panel-tab${tab.id === activeTabId ? " is-active" : ""}`;
        button.textContent = tab.label;
        button.setAttribute("role", "tab");
        button.setAttribute("aria-selected", String(tab.id === activeTabId));
        button.addEventListener("click", () => selectTab(tab.id));
        return button;
      }),
    );
  }

  function selectTab(tabId) {
    activeTabId = tabId;
    renderTabs();
    renderSubTabs();
    void loadActiveTab();
  }

  // The Memory tab hosts its own segmented sub-tab bar; it stays hidden for
  // every other top-level tab.
  function renderSubTabs() {
    const showSubTabs = activeTabId === "memory";
    subTabsElement.hidden = !showSubTabs;
    if (!showSubTabs) {
      subTabsElement.replaceChildren();
      return;
    }
    subTabsElement.replaceChildren(
      ...memorySubTabs.map((subTab) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `panel-subtab${subTab.id === activeMemorySubTabId ? " is-active" : ""}`;
        button.textContent = subTab.label;
        button.setAttribute("role", "tab");
        button.setAttribute("aria-selected", String(subTab.id === activeMemorySubTabId));
        button.addEventListener("click", () => selectMemorySubTab(subTab.id));
        return button;
      }),
    );
  }

  function selectMemorySubTab(subTabId) {
    activeMemorySubTabId = subTabId;
    renderSubTabs();
    void loadActiveTab();
  }

  async function loadActiveTab({ animate = true } = {}) {
    const tab = tabs.find((item) => item.id === activeTabId) ?? tabs[0];
    editableText.clear();
    clearSelection();
    animateNextRender = animate;
    // Skip the loading flash on silent in-place refreshes (e.g. after
    // deleting/completing selected items) so the list updates without a blink.
    if (animate) {
      setLoading();
    }
    try {
      if (tab.id === "tasks") {
        renderTasks(await bridge.getPlannerTasks());
      } else if (tab.id === "calendar") {
        renderCalendar(await bridge.getCalendarItems());
      } else if (tab.id === "screenshots") {
        renderScreenshots(await bridge.listScreenshots());
      } else if (tab.id === "memory") {
        if (activeMemorySubTabId === "daily") {
          renderDailyLogs(await bridge.getDailyLogs());
        } else if (activeMemorySubTabId === "soul") {
          renderSoulNotes(await bridge.getSoulNotes());
        } else {
          renderMemory(await bridge.getMemoryFacts());
        }
      } else if (tab.id === "computer") {
        renderComputer(await bridge.getActivity("computer_use"));
      }
    } catch (error) {
      renderError(error);
    }
  }

  function mountBody(...nodes) {
    bodyElement.classList.toggle("no-animate", !animateNextRender);
    bodyElement.replaceChildren(...nodes);
    applyStagger(bodyElement.children);
  }

  function applyStagger(children) {
    let index = 0;
    for (const child of children) {
      child.style.setProperty("--stagger", String(Math.min(index, 14)));
      index += 1;
    }
  }

  function setLoading() {
    const loading = buildEmptyState("Loading…", "");
    loading.classList.add("is-loading");
    loading.setAttribute("role", "status");
    mountBody(loading);
    setFooter("");
  }

  // Wires a rendered row/card so clicking it toggles selection + highlight.
  function makeSelectable(element, id) {
    if (!id) {
      return element;
    }
    element.classList.add("is-selectable");
    element.dataset.selectId = id;
    if (selectedIds.has(id)) {
      element.classList.add("is-selected");
    }
    element.addEventListener("click", () => {
      if (!element.classList.contains("is-editing")) {
        toggleSelection(id, element);
      }
    });
    return element;
  }

  function toggleSelection(id, element) {
    if (selectedIds.has(id)) {
      selectedIds.delete(id);
      element.classList.remove("is-selected");
    } else {
      selectedIds.add(id);
      element.classList.add("is-selected");
    }
    updateSelectionBar();
  }

  function clearSelection() {
    selectedIds.clear();
    updateSelectionBar();
  }

  function ensureSelectionBar() {
    if (selectionBar) {
      return selectionBar;
    }
    selectionBar = document.createElement("div");
    selectionBar.className = "panel-selection-bar";
    selectionBar.hidden = true;

    selectionCountElement = document.createElement("span");
    selectionCountElement.className = "panel-selection-count";

    selectionDoneButton = document.createElement("button");
    selectionDoneButton.type = "button";
    selectionDoneButton.className = "selection-action selection-done";
    selectionDoneButton.append(buildSelectionIcon("check"), buildSelectionLabel("Done"));
    selectionDoneButton.addEventListener("click", () => void completeSelection());

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "selection-action selection-delete";
    deleteButton.append(buildSelectionIcon("trash"), buildSelectionLabel("Delete"));
    deleteButton.addEventListener("click", () => void deleteSelection());

    selectionEditButton = document.createElement("button");
    selectionEditButton.type = "button";
    selectionEditButton.className = "selection-action selection-edit";
    selectionEditButton.append(buildSelectionIcon("pencil"), buildSelectionLabel("Edit"));
    selectionEditButton.addEventListener("click", () => startEditingSelection());

    const actions = document.createElement("div");
    actions.className = "panel-selection-actions";
    actions.append(selectionDoneButton, selectionEditButton, deleteButton);

    selectionBar.append(selectionCountElement, actions);
    panelElement.append(selectionBar);
    return selectionBar;
  }

  function updateSelectionBar() {
    const bar = ensureSelectionBar();
    const count = selectedIds.size;
    const hasSelection = count > 0 && selectableTabs.has(activeTabId);
    bodyElement.classList.toggle("has-selection", hasSelection);
    if (!hasSelection) {
      bar.classList.remove("is-visible");
      bar.hidden = true;
      return;
    }
    selectionCountElement.textContent = `${count} selected`;
    selectionDoneButton.hidden = activeTabId !== "tasks";
    // Memory entries are edited one at a time, in place.
    selectionEditButton.hidden =
      activeTabId !== "memory" || count !== 1 || !editableText.has([...selectedIds][0]);
    bar.hidden = false;
    requestAnimationFrame(() => bar.classList.add("is-visible"));
  }

  async function deleteSelection() {
    const ids = [...selectedIds];
    if (ids.length === 0) {
      return;
    }
    if (activeTabId === "tasks") {
      await bridge.deletePlannerTasks(ids);
    } else if (activeTabId === "calendar") {
      await bridge.deleteCalendarItems(ids);
    } else if (activeTabId === "screenshots") {
      await bridge.deleteScreenshots(ids);
    } else if (activeTabId === "memory") {
      if (activeMemorySubTabId === "daily") {
        await bridge.deleteDailyLogs(ids);
      } else if (activeMemorySubTabId === "soul") {
        await bridge.deleteSoulNotes(ids);
      } else {
        await bridge.deleteMemoryFacts(ids);
      }
    }
    await loadActiveTab({ animate: false });
  }

  async function completeSelection() {
    const ids = [...selectedIds];
    if (ids.length === 0 || activeTabId !== "tasks") {
      return;
    }
    await bridge.completePlannerTasks(ids);
    await loadActiveTab({ animate: false });
  }

  // Swap the selected memory row's text for an editor. Only the text is
  // editable; the category/subject/date stay as they are.
  function startEditingSelection() {
    const id = [...selectedIds][0];
    const original = editableText.get(id);
    const row = [...bodyElement.querySelectorAll("[data-select-id]")].find(
      (element) => element.dataset.selectId === id,
    );
    const editKind = memorySubTabs.find((subTab) => subTab.id === activeMemorySubTabId)?.editKind;
    if (!row || original === undefined || !editKind) {
      return;
    }
    clearSelection();
    row.classList.remove("is-selected", "is-selectable");
    row.classList.add("is-editing");

    const editor = document.createElement("div");
    editor.className = "panel-edit";
    editor.addEventListener("click", (event) => event.stopPropagation());
    const input = document.createElement("textarea");
    input.className = "agent-textarea panel-edit-input";
    input.value = original;
    input.rows = Math.min(8, Math.max(2, original.split("\n").length));
    input.maxLength = editKind === "daily" ? 4000 : 300;
    input.setAttribute("aria-label", "Edit memory");
    const status = document.createElement("span");
    status.className = "panel-edit-status";
    status.setAttribute("role", "status");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "selection-action selection-edit";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => void loadActiveTab({ animate: false }));
    const save = document.createElement("button");
    save.type = "button";
    save.className = "selection-action selection-done";
    save.textContent = "Save";
    save.addEventListener("click", async () => {
      const value = input.value.trim();
      if (!value) {
        status.textContent = "Can't be empty. Use Delete to remove it.";
        return;
      }
      save.disabled = true;
      try {
        const result = await bridge.updateMemoryEntry(editKind, Number(id), value);
        if (result?.status !== "updated") {
          throw new Error(result?.message ?? "It may have been deleted.");
        }
        await loadActiveTab({ animate: false });
      } catch (error) {
        save.disabled = false;
        status.textContent = `Couldn't save. ${error instanceof Error ? error.message : ""}`.trim();
      }
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel.click();
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        save.click();
      }
    });
    const actions = document.createElement("div");
    actions.className = "panel-edit-actions";
    actions.append(status, cancel, save);
    editor.append(input, actions);

    for (const child of [...row.querySelectorAll(".panel-row-subtext")]) {
      child.remove();
    }
    row.querySelector(".panel-row-title")?.after(editor);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function buildSelectionLabel(text) {
    const label = document.createElement("span");
    label.textContent = text;
    return label;
  }

  function buildSelectionIcon(kind) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "selection-action-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "13");
    svg.setAttribute("height", "13");
    svg.setAttribute("fill", "none");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    if (kind === "pencil") {
      path.setAttribute("d", "M4 20h4L19 9l-4-4L4 16v4Zm9-13 4 4");
    } else if (kind === "trash") {
      path.setAttribute(
        "d",
        "M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12",
      );
    } else {
      path.setAttribute("d", "M5 12.5 10 17l9-10");
    }
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    return svg;
  }

  function renderError(error) {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    mountBody(buildEmptyState("Couldn't load", message));
  }

  function renderTasks(tasksList) {
    const list = Array.isArray(tasksList) ? tasksList : [];
    if (list.length === 0) {
      mountBody(buildEmptyState("No tasks yet", "Ask Brah to remember something."));
      setFooter("No tasks");
      return;
    }
    const grouped = new Map(statusOrder.map((status) => [status, []]));
    for (const task of list) {
      const bucket = grouped.get(task.status) ?? grouped.get("todo");
      bucket.push(task);
    }
    const sections = [];
    for (const status of statusOrder) {
      const items = grouped.get(status);
      if (!items || items.length === 0) {
        continue;
      }
      sections.push(buildSectionHeader(statusLabels[status]));
      for (const task of items) {
        sections.push(buildTaskRow(task));
      }
    }
    mountBody(...sections);
    setFooter(`${list.length} ${list.length === 1 ? "task" : "tasks"}`);
  }

  function buildTaskRow(task) {
    const row = document.createElement("article");
    row.className = "panel-row";

    const indicator = document.createElement("span");
    indicator.className = `state-dot state-${task.status}`;
    row.append(indicator);

    const content = document.createElement("div");
    content.className = "panel-row-content";
    const title = document.createElement("div");
    title.className = "panel-row-title";
    title.textContent = task.name;
    content.append(title);
    if (task.description) {
      const description = document.createElement("p");
      description.className = "panel-row-subtext";
      description.textContent = task.description;
      content.append(description);
    }
    row.append(content);

    const priority = document.createElement("span");
    priority.className = `priority-pill priority-${task.priority}`;
    priority.textContent = task.priority;
    row.append(priority);
    return makeSelectable(row, task.id);
  }

  function renderCalendar(calendarItems) {
    const list = Array.isArray(calendarItems) ? calendarItems : [];
    if (list.length === 0) {
      mountBody(buildEmptyState("Nothing scheduled", "Ask Brah to add a calendar item."));
      setFooter("No events");
      return;
    }
    const groups = new Map();
    for (const item of list) {
      const label = item.date || "No date";
      if (!groups.has(label)) {
        groups.set(label, []);
      }
      groups.get(label).push(item);
    }
    const sections = [];
    for (const [label, items] of groups) {
      sections.push(buildSectionHeader(label));
      for (const item of items) {
        sections.push(buildCalendarRow(item));
      }
    }
    mountBody(...sections);
    setFooter(`${list.length} ${list.length === 1 ? "event" : "events"}`);
  }

  function buildCalendarRow(item) {
    const row = document.createElement("article");
    row.className = "panel-row";

    const time = document.createElement("span");
    time.className = "calendar-time";
    time.textContent = item.time || "—";
    row.append(time);

    const content = document.createElement("div");
    content.className = "panel-row-content";
    const title = document.createElement("div");
    title.className = "panel-row-title";
    title.textContent = item.title;
    content.append(title);
    if (item.description) {
      const description = document.createElement("p");
      description.className = "panel-row-subtext";
      description.textContent = item.description;
      content.append(description);
    }
    row.append(content);
    return makeSelectable(row, item.id);
  }

  function renderScreenshots(screenshots) {
    const list = (Array.isArray(screenshots) ? screenshots : []).slice(0, MAX_ACTIVITY_ITEMS);
    if (list.length === 0) {
      mountBody(buildEmptyState("No screenshots yet", "Ask Brah to capture your screen."));
      setFooter("No screenshots");
      return;
    }
    const grid = document.createElement("div");
    grid.className = "screenshot-grid";
    for (const shot of list) {
      const figure = document.createElement("figure");
      figure.className = "screenshot-card";
      const image = document.createElement("img");
      image.className = "screenshot-thumb";
      image.src = shot.dataUrl;
      image.alt = shot.name;
      const caption = document.createElement("figcaption");
      caption.className = "screenshot-caption";
      caption.textContent = formatTime(shot.createdAt);
      const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.className = "screenshot-reveal";
      reveal.textContent = "Reveal";
      reveal.addEventListener("click", (event) => {
        event.stopPropagation();
        void bridge.revealScreenshot(shot.name);
      });
      figure.append(image, caption, reveal);
      grid.append(makeSelectable(figure, shot.name));
    }
    applyStagger(grid.children);
    mountBody(grid);
    setFooter(`${list.length} ${list.length === 1 ? "screenshot" : "screenshots"}`);
  }

  // Memory facts render the pocket-agent way: grouped by category, each fact
  // shown as subject + content with its "as of" (updated) date.
  function renderMemory(facts) {
    const list = Array.isArray(facts) ? facts : [];
    if (list.length === 0) {
      mountBody(
        buildEmptyState("Your memory is empty", "Tell Brah things and he'll remember them."),
      );
      setFooter("No memories");
      return;
    }
    const sorted = [...list].sort(
      (a, b) =>
        String(a.category).localeCompare(String(b.category)) ||
        String(a.subject).localeCompare(String(b.subject)),
    );
    const groups = new Map();
    for (const fact of sorted) {
      const label = fact.category || "uncategorized";
      if (!groups.has(label)) {
        groups.set(label, []);
      }
      groups.get(label).push(fact);
    }
    const sections = [];
    for (const [label, groupFacts] of groups) {
      sections.push(buildSectionHeader(label));
      for (const fact of groupFacts) {
        sections.push(buildMemoryRow(fact));
      }
    }
    mountBody(...sections);
    setFooter(`${list.length} ${list.length === 1 ? "memory" : "memories"}`);
  }

  function buildMemoryRow(fact) {
    const row = document.createElement("article");
    row.className = "panel-row panel-row-block";
    const title = document.createElement("div");
    title.className = "panel-row-title";
    title.textContent = fact.subject || fact.category || "Fact";
    row.append(title);
    if (fact.content) {
      const content = document.createElement("p");
      content.className = "panel-row-subtext";
      content.textContent = fact.content;
      row.append(content);
    }
    editableText.set(String(fact.id), String(fact.content ?? ""));
    // Provenance: every entry shows who wrote it, so it can be audited.
    const metaParts = [formatTime(fact.updated_at), factSourceLabels[fact.source]].filter(Boolean);
    if (fact.sensitive) {
      metaParts.push("private");
    }
    if (metaParts.length > 0) {
      row.append(buildMeta(metaParts.join(" · ")));
    }
    return makeSelectable(row, String(fact.id));
  }

  // Working notes: lessons about how the user wants Brah to work with them,
  // one per aspect, sorted by aspect.
  function renderSoulNotes(notes) {
    const list = Array.isArray(notes) ? notes : [];
    if (list.length === 0) {
      mountBody(
        buildEmptyState(
          "No working notes yet",
          "Correct how Brah talks or works with you and he'll note it here.",
        ),
      );
      setFooter("No notes");
      return;
    }
    mountBody(...list.map((note) => buildSoulRow(note)));
    setFooter(`${list.length} ${list.length === 1 ? "note" : "notes"}`);
  }

  function buildSoulRow(note) {
    const row = document.createElement("article");
    row.className = "panel-row panel-row-block";
    const title = document.createElement("div");
    title.className = "panel-row-title";
    title.textContent = String(note.aspect ?? "note").replaceAll("_", " ");
    const content = document.createElement("p");
    content.className = "panel-row-subtext";
    content.textContent = note.content ?? "";
    row.append(title, content);
    const updated = formatTime(note.updated_at);
    if (updated) {
      row.append(buildMeta(updated));
    }
    editableText.set(String(note.id), String(note.content ?? ""));
    return makeSelectable(row, String(note.id));
  }

  // Daily logs render the pocket-agent way: one card per day (most recent first),
  // each timestamped entry on its own line.
  function renderDailyLogs(logs) {
    const list = Array.isArray(logs) ? logs : [];
    if (list.length === 0) {
      mountBody(
        buildEmptyState("No daily logs yet", "Brah journals what you work on as you talk."),
      );
      setFooter("No logs");
      return;
    }
    const rows = list.map((log) => buildDailyLogRow(log));
    mountBody(...rows);
    setFooter(`${list.length} ${list.length === 1 ? "day" : "days"}`);
  }

  function buildDailyLogRow(log) {
    const row = document.createElement("article");
    row.className = "panel-row panel-row-block";
    const title = document.createElement("div");
    title.className = "panel-row-title";
    title.textContent = formatLogDate(log.date);
    row.append(title);
    const entries = String(log.content ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const entry of entries) {
      const line = document.createElement("p");
      line.className = "panel-row-subtext";
      line.textContent = entry;
      row.append(line);
    }
    editableText.set(String(log.id), String(log.content ?? ""));
    return makeSelectable(row, String(log.id));
  }

  function formatLogDate(date) {
    if (typeof date !== "string" || !date) {
      return "Log";
    }
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    if (date === todayKey) {
      return "Today";
    }
    const parsed = new Date(`${date}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) {
      return date;
    }
    return parsed.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }

  function renderComputer(runs) {
    const list = (Array.isArray(runs) ? runs : []).slice(0, MAX_ACTIVITY_ITEMS);
    if (list.length === 0) {
      mountBody(buildEmptyState("No computer runs", "Ask Brah to use the browser for you."));
      setFooter("No runs");
      return;
    }
    const rows = list.map((run) => buildComputerRow(run));
    mountBody(...rows);
    setFooter(`${list.length} ${list.length === 1 ? "run" : "runs"}`);
  }

  function buildComputerRow(run) {
    const row = document.createElement("article");
    row.className = "panel-row panel-row-block";
    const header = document.createElement("div");
    header.className = "panel-row-head";
    const title = document.createElement("div");
    title.className = "panel-row-title";
    title.textContent = run.task || "Computer task";
    const badge = document.createElement("span");
    badge.className = `status-badge status-${run.statusText || "unknown"}`;
    badge.textContent = computerRunStatusLabels[run.statusText] || run.statusText || "Unknown";
    header.append(title, badge);
    row.append(header);
    if (run.finalText) {
      const final = document.createElement("p");
      final.className = "panel-row-subtext";
      final.textContent = run.finalText;
      row.append(final);
    }
    row.append(buildMeta(`${run.steps ?? 0} steps · ${formatTime(run.time)}`));
    return row;
  }

  function buildSectionHeader(label) {
    const header = document.createElement("h3");
    header.className = "panel-section-header";
    header.textContent = label;
    return header;
  }

  function buildEmptyState(title, hint) {
    const wrapper = document.createElement("div");
    wrapper.className = "panel-empty";
    const heading = document.createElement("p");
    heading.className = "panel-empty-title";
    heading.textContent = title;
    wrapper.append(heading);
    if (hint) {
      const subtext = document.createElement("p");
      subtext.className = "panel-empty-hint";
      subtext.textContent = hint;
      wrapper.append(subtext);
    }
    return wrapper;
  }

  function buildMeta(text) {
    const meta = document.createElement("p");
    meta.className = "panel-row-meta";
    meta.textContent = text;
    return meta;
  }

  function setFooter(text) {
    if (footerElement) {
      footerElement.textContent = text;
    }
  }

  function formatTime(value) {
    if (value === undefined || value === null) {
      return "";
    }
    const date = typeof value === "number" ? new Date(value) : new Date(String(value));
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function handleDataChanged(payload) {
    if (!isOpen) {
      return;
    }
    // On the Memory tab, the live category depends on the active sub-tab
    // (facts vs. daily logs), so a change only refreshes the matching section.
    const activeCategory =
      activeTabId === "memory"
        ? memorySubTabs.find((subTab) => subTab.id === activeMemorySubTabId)?.category
        : tabs.find((tab) => tab.id === activeTabId)?.category;
    if (!payload?.category || payload.category === activeCategory) {
      void loadActiveTab();
    }
  }

  async function open({ skipWindowMode = false } = {}) {
    if (isOpen) {
      return;
    }
    isOpen = true;
    panelElement.hidden = false;
    onModeChange?.("panel");
    // The caller (e.g. a call-end layout swap) may already be resizing the window
    // to panel size; skip the redundant resize+fade so the two don't compound.
    if (!skipWindowMode) {
      await bridge.setWindowMode("panel");
    }
    requestAnimationFrame(() => panelElement.classList.add("is-open"));
    renderTabs();
    renderSubTabs();
    await loadActiveTab();
  }

  async function close({ windowMode = "call", immediate = false, skipWindowMode = false } = {}) {
    if (!isOpen) {
      return;
    }
    isOpen = false;
    clearSelection();
    panelElement.classList.remove("is-open");
    onModeChange?.("orb");
    // immediate hides the panel synchronously (no fade) so a caller resizing the
    // window next does not flash the full panel squished into the small frame.
    if (immediate) {
      panelElement.hidden = true;
    }
    if (!skipWindowMode) {
      await bridge.setWindowMode(windowMode);
    }
    if (!immediate) {
      window.setTimeout(() => {
        if (!isOpen) {
          panelElement.hidden = true;
        }
      }, 160);
    }
  }

  function init({ openByDefault = false } = {}) {
    renderTabs();
    renderSubTabs();
    dataChangedListener = bridge.onDataChanged?.(handleDataChanged) ?? null;
    if (openByDefault) {
      void open();
    }
  }

  return {
    init,
    open,
    close,
    isOpen: () => isOpen,
    dispose() {
      if (dataChangedListener) {
        bridge.offDataChanged?.(dataChangedListener);
        dataChangedListener = null;
      }
    },
  };
}
