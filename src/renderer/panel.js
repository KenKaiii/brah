const tabs = Object.freeze([
  { id: "tasks", label: "Tasks", category: "tasks" },
  { id: "calendar", label: "Calendar", category: "calendar" },
  { id: "screenshots", label: "Shots", category: "screenshots" },
  { id: "web", label: "Web", category: "web" },
  { id: "computer", label: "Computer", category: "computer" },
]);

const MAX_ACTIVITY_ITEMS = 20;

const statusOrder = Object.freeze(["in_progress", "todo", "completed"]);
const statusLabels = Object.freeze({
  todo: "To do",
  in_progress: "In progress",
  completed: "Completed",
});

export function createPanelController({ brah, onModeChange } = {}) {
  const bridge = brah ?? window.brah;
  const panelElement = document.querySelector("#panel");
  const tabsElement = document.querySelector("#panel-tabs");
  const bodyElement = document.querySelector("#panel-body");
  const footerElement = document.querySelector("#panel-footer-text");

  let isOpen = false;
  let activeTabId = tabs[0].id;
  let dataChangedListener = null;
  let selectionBar = null;
  let selectionCountElement = null;
  let selectionDoneButton = null;
  let animateNextRender = true;
  const selectedIds = new Set();

  // Tabs whose items support multi-select + delete.
  const selectableTabs = Object.freeze(new Set(["tasks", "calendar", "screenshots"]));

  function renderTabs() {
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
    void loadActiveTab();
  }

  async function loadActiveTab({ animate = true } = {}) {
    const tab = tabs.find((item) => item.id === activeTabId) ?? tabs[0];
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
      } else if (tab.id === "web") {
        renderWeb(await bridge.getActivity("web_search"), await bridge.getActivity("web_fetch"));
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
    mountBody(buildEmptyState("Loading…", ""));
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
    element.addEventListener("click", () => toggleSelection(id, element));
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

    const actions = document.createElement("div");
    actions.className = "panel-selection-actions";
    actions.append(selectionDoneButton, deleteButton);

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
    if (kind === "trash") {
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

  function renderWeb(searches, fetches) {
    const searchList = (Array.isArray(searches) ? searches : []).slice(0, MAX_ACTIVITY_ITEMS);
    const fetchList = (Array.isArray(fetches) ? fetches : []).slice(0, MAX_ACTIVITY_ITEMS);
    if (searchList.length === 0 && fetchList.length === 0) {
      mountBody(buildEmptyState("No web activity", "Ask Brah to search or read a page."));
      setFooter("No web activity");
      return;
    }
    const sections = [];
    if (searchList.length > 0) {
      sections.push(buildSectionHeader("Searches"));
      for (const entry of searchList) {
        sections.push(buildSearchRow(entry));
      }
    }
    if (fetchList.length > 0) {
      sections.push(buildSectionHeader("Reads"));
      for (const entry of fetchList) {
        sections.push(buildFetchRow(entry));
      }
    }
    mountBody(...sections);
    setFooter(`${searchList.length + fetchList.length} items`);
  }

  function buildSearchRow(entry) {
    const row = document.createElement("article");
    row.className = "panel-row panel-row-block";
    const title = document.createElement("div");
    title.className = "panel-row-title";
    title.textContent = entry.query || "Search";
    row.append(title);
    const results = Array.isArray(entry.results) ? entry.results.slice(0, 3) : [];
    for (const result of results) {
      const link = document.createElement("p");
      link.className = "panel-row-subtext";
      link.textContent = result.title ? `${result.title} — ${result.url}` : result.url;
      row.append(link);
    }
    row.append(buildMeta(formatTime(entry.time)));
    return row;
  }

  function buildFetchRow(entry) {
    const row = document.createElement("article");
    row.className = "panel-row panel-row-block";
    const title = document.createElement("div");
    title.className = "panel-row-title";
    title.textContent = entry.title || entry.url || "Page";
    row.append(title);
    if (entry.url) {
      const url = document.createElement("p");
      url.className = "panel-row-subtext panel-row-url";
      url.textContent = entry.url;
      row.append(url);
    }
    if (entry.text) {
      const excerpt = document.createElement("p");
      excerpt.className = "panel-row-subtext";
      excerpt.textContent = entry.text;
      row.append(excerpt);
    }
    row.append(buildMeta(formatTime(entry.time)));
    return row;
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
    badge.textContent = run.statusText || "unknown";
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
    const activeTab = tabs.find((tab) => tab.id === activeTabId);
    if (!payload?.category || payload.category === activeTab?.category) {
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
