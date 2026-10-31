const AUDIT_KEY = "what-ai-fails-to-see.audit.v1";
const AUDIT_OPTIONS = {
  description: [["", "Not assessed"], ["meets_goal", "Addresses the question"],
    ["misses_goal", "Misses the question"], ["uncertain", "Unclear"]],
  answer: [["", "Not assessed"], ["supported", "Supported by the image"],
    ["unsupported", "Unsupported or contradicted"], ["uncertain", "Unclear"]],
  follow_up: [["", "Not assessed"], ["none", "No follow-up needed"],
    ["retake", "Retake the photo"], ["verify", "Verify with a person"],
    ["uncertain", "Unclear"]],
};
const state = { data: null, index: 0, search: "", tableSearch: "", view: "voices", filterLimit: 50,
  audits: {}, auditMessage: "",
  filters: { blur: false, framing: false, textHeavy: false, unanswerable: false,
    stakes: "all", provider: "all", answered: false, needsAudit: false } };

function auditModelIds(data) {
  return Object.fromEntries(["codex", "ollama"].map(provider =>
    [provider, data.records.find(record => record.models[provider]?.model_requested)?.models[provider].model_requested || null]));
}

function validateAuditFile(file, data) {
  if (!file || file.schema_version !== 1 || file.sample_seed !== data.sample.seed ||
      JSON.stringify(file.model_ids) !== JSON.stringify(auditModelIds(data)) ||
      !file.ratings || typeof file.ratings !== "object" || Array.isArray(file.ratings))
    throw new Error("Audit file does not match this sample and these model versions.");
  const names = new Set(data.records.map(record => record.image));
  const clean = {};
  for (const [name, providers] of Object.entries(file.ratings)) {
    if (!names.has(name) || !providers || typeof providers !== "object" || Array.isArray(providers))
      throw new Error("Audit file contains an unknown image or invalid record.");
    clean[name] = {};
    for (const [provider, values] of Object.entries(providers)) {
      if (!["codex", "ollama"].includes(provider) || !values || typeof values !== "object" || Array.isArray(values))
        throw new Error("Audit file contains an invalid model review.");
      const item = {};
      for (const field of ["description", "answer", "follow_up"]) {
        const value = values[field] || "";
        if (!AUDIT_OPTIONS[field].some(([option]) => option === value))
          throw new Error(`Invalid ${field} label in audit file.`);
        item[field] = value;
      }
      if (typeof (values.note || "") !== "string" || (values.note || "").length > 2000)
        throw new Error("Audit notes must be text shorter than 2,000 characters.");
      item.note = values.note || "";
      clean[name][provider] = item;
    }
  }
  return clean;
}

function auditFile(data, ratings) {
  return { schema_version: 1, sample_seed: data.sample.seed,
    model_ids: auditModelIds(data), exported_at: new Date().toISOString(), ratings };
}

function saveAudits() {
  try {
    localStorage.setItem(AUDIT_KEY, JSON.stringify(auditFile(state.data, state.audits)));
    state.auditMessage = "Saved in this browser. Export a copy to keep or share your review.";
  } catch (error) {
    state.auditMessage = `Browser storage unavailable: ${error.message}. Export your review now.`;
  }
  renderAuditStatus();
}

function completeAuditCount(name) {
  return ["codex", "ollama"].filter(provider => {
    const item = state.audits[name]?.[provider];
    return item?.description && item?.answer;
  }).length;
}

function renderAuditStatus() {
  const status = byId("audit-status");
  if (!status || !state.data) return;
  const reviewed = state.data.records.filter(record => completeAuditCount(record.image) === 2).length;
  status.textContent = `${reviewed} of ${state.data.records.length} images reviewed for both models. ${state.auditMessage}`;
}

function auditSelect(name, provider, field, title) {
  const wrapper = node("label", "audit-field", title);
  const select = node("select");
  for (const [value, caption] of AUDIT_OPTIONS[field]) {
    const option = node("option", "", caption); option.value = value; select.append(option);
  }
  select.value = state.audits[name]?.[provider]?.[field] || "";
  select.addEventListener("change", () => {
    state.audits[name] ||= {}; state.audits[name][provider] ||= {};
    state.audits[name][provider][field] = select.value;
    saveAudits();
  });
  wrapper.append(select); return wrapper;
}

function renderAuditWorkspace(record) {
  const target = byId("audit-workspace"); clear(target);
  target.append(node("h3", "", "Analyst review"));
  target.append(node("p", "audit-intro", "Label each model against the original question and image. These are your judgments, stored in this browser; source labels and model outputs stay separate."));
  const grid = node("div", "audit-grid");
  for (const [provider, title] of [["codex", "Closed model"], ["ollama", "Open model"]]) {
    const panel = node("section", "audit-panel"); panel.append(node("h4", "", title));
    for (const [field, labelText] of [["description", "Generic description"], ["answer", "Answer"], ["follow_up", "Suggested next step"]])
      panel.append(auditSelect(record.image, provider, field, labelText));
    const note = node("label", "audit-field", "Evidence or reason (optional)");
    const input = node("textarea"); input.rows = 3; input.maxLength = 2000;
    input.value = state.audits[record.image]?.[provider]?.note || "";
    input.addEventListener("change", () => {
      state.audits[record.image] ||= {}; state.audits[record.image][provider] ||= {};
      state.audits[record.image][provider].note = input.value; saveAudits();
    });
    note.append(input); panel.append(note); grid.append(panel);
  }
  target.append(grid);
  const status = node("p", "audit-status"); status.id = "audit-status"; status.setAttribute("aria-live", "polite");
  target.append(status); renderAuditStatus();
}

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = String(text);
  return item;
}

function clear(target) { target.replaceChildren(); }
function byId(id) { return document.getElementById(id); }
function label(text) { return node("span", "small-label", text); }

function setView(view) {
  state.view = view;
  for (const section of document.querySelectorAll(".view")) section.hidden = section.id !== view;
  for (const tab of document.querySelectorAll(".view-tab")) {
    const selected = tab.dataset.view === view;
    tab.classList.toggle("active", selected);
    if (selected) tab.setAttribute("aria-current", "page"); else tab.removeAttribute("aria-current");
  }
  history.replaceState(null, "", `#${view}`);
  if (view === "breaks") { renderOverview(); renderFilters(); }
  if (view === "next") renderEditorial();
}

function setIndex(index) {
  const records = state.data.records;
  state.index = (index + records.length) % records.length;
  renderRecord();
}

function renderRecord() {
  const record = state.data.records[state.index];
  byId("record-position").textContent = `${state.index + 1} / ${state.data.records.length}`;
  const photo = byId("photo-slot"); clear(photo);
  if (record.image_available) {
    const img = node("img");
    img.src = record.image_url || `images/${record.image}`;
    const caption = record.captions.find(item => !item.is_rejected && !item.is_precanned);
    img.alt = caption ? `VizWiz source photograph ${record.image}. Human caption: ${caption.caption}` : `VizWiz source photograph ${record.image}. No usable human caption is available.`;
    img.loading = "lazy";
    photo.append(img);
  } else photo.append(node("p", "empty-state", "Photograph not downloaded yet."));

  const source = byId("source-meta"); clear(source);
  source.append(node("span", "filename", record.image));
  source.append(node("span", "status-pill", record.privacy_review === "approved" ? "Privacy reviewed" : "Privacy review pending"));
  const archive = node("a", "archive-link", "Original image archive ↗");
  archive.href = "https://vizwiz.cs.colorado.edu/VizWiz_final/images/val.zip";
  archive.target = "_blank"; archive.rel = "noopener noreferrer";
  source.append(archive);
  const stats = node("div", "source-stats");
  stats.append(node("span", "", record.answerable ? "Labeled answerable" : "Labeled unanswerable"));
  stats.append(node("span", "", `Blur ${record.quality_votes.BLR}/5`));
  stats.append(node("span", "", `Framing ${record.quality_votes.FRM}/5`));
  stats.append(node("span", "", `Stakes: ${record.stakes.replace("_", " ")}`));
  source.append(stats);
  byId("question-text").textContent = `“${record.question}”`;

  const captions = byId("human-captions"); clear(captions);
  const usable = record.captions.filter(item => !item.is_rejected && !item.is_precanned).length;
  captions.append(label(`FIVE CAPTION SLOTS · ${usable} USABLE`));
  const captionList = node("ol", "caption-list");
  for (const item of record.captions) {
    const row = node("li", item.is_rejected || item.is_precanned ? "flagged-caption" : "");
    row.append(node("span", "", item.caption));
    if (item.is_rejected) row.append(node("span", "annotation-flag", "Rejected"));
    if (item.is_precanned) row.append(node("span", "annotation-flag", "Pre-canned"));
    captionList.append(row);
  }
  captions.append(captionList);
  const answers = byId("human-answers"); clear(answers);
  answers.append(label("TEN CROWD ANSWERS"));
  const answerList = node("ol", "answer-list");
  for (const item of record.answers) {
    const row = node("li"); row.append(node("span", "", item.answer));
    row.append(node("span", "confidence", item.answer_confidence)); answerList.append(row);
  }
  answers.append(answerList);

  const outputs = byId("model-output"); clear(outputs);
  for (const [provider, title] of [["codex", "Closed model"], ["ollama", "Open model"]]) {
    const model = record.models[provider];
    const card = node("section", "model-card");
    const head = node("div", "model-head"); head.append(node("h4", "", title));
    head.append(node("span", "model-id", model.model_requested || "Not run")); card.append(head);
    for (const [key, title] of [["description", "Generic description"], ["answer", "Answer to the question"]]) {
      const task = model[key];
      const box = node("div", key === "answer" ? "model-task answer-task" : "model-task");
      box.append(label(title));
      if (!task || !task.status || task.status === "not_run") box.append(node("p", "missing-output", "No model output yet."));
      else if (task.status === "success") box.append(node("p", "model-text", task.text));
      else if (task.status === "refusal") box.append(node("p", "missing-output", `Refusal: ${task.refusal || "No answer returned."}`));
      else box.append(node("p", "missing-output", `Run ${task.status}: ${task.error || "No text returned."}`));
      card.append(box);
    }
    outputs.append(card);
  }
  renderAuditWorkspace(record);
}

function renderSearch() {
  const target = byId("search-results"); clear(target);
  const query = state.search.trim().toLowerCase();
  if (!query) { target.hidden = true; return; }
  const matches = state.data.records.map((record, index) => ({ record, index }))
    .filter(({ record }) => `${record.image} ${record.question}`.toLowerCase().includes(query)).slice(0, 12);
  target.hidden = false;
  if (!matches.length) { target.append(node("p", "", "No matching questions.")); return; }
  for (const { record, index } of matches) {
    const button = node("button", "search-result", `${record.question} · ${record.image}`);
    button.type = "button";
    button.addEventListener("click", () => { setIndex(index); byId("record-search").value = ""; state.search = ""; renderSearch(); });
    target.append(button);
  }
}

function renderSummary() {
  const { sample, summary } = state.data;
  const target = byId("summary"); clear(target);
  for (const [number, caption] of [[sample.selected, "selected images"], [sample.frame, "joined validation images"], [summary.image_available, "photos available locally"]]) {
    const stat = node("div", "summary-stat"); stat.append(node("strong", "", number)); stat.append(node("span", "", caption)); target.append(stat);
  }
}

function countIf(predicate) { return state.data.records.filter(predicate).length; }

function chartRow(title, count, total, detail) {
  const row = node("div", "chart-row");
  const heading = node("div", "chart-row-heading");
  heading.append(node("span", "", title), node("strong", "", `${count} / ${total}`));
  const track = node("div", "chart-track");
  const bar = node("div", "chart-bar");
  bar.style.width = `${total ? (count / total) * 100 : 0}%`;
  track.append(bar);
  row.append(heading, track);
  if (detail) row.append(node("p", "chart-detail", detail));
  return row;
}

function renderOverview() {
  const target = byId("overview"); clear(target);
  const records = state.data.records;
  const total = records.length;
  const intro = node("div", "overview-intro");
  intro.append(node("h3", "", "The full selected sample, at a glance"));
  intro.append(node("p", "", `Every count below uses the ${total} records available in this ${["public_reviewed", "public_wip"].includes(state.data.mode) ? (state.data.mode === "public_wip" ? "public work-in-progress sample" : "reviewed public subset") : "private local sample"}. Conditions can overlap. These are source labels and output availability, not judged model failures.`));
  target.append(intro);
  const grid = node("div", "overview-grid");
  const source = node("section", "chart-panel");
  source.append(node("h4", "", "What the source data says"));
  for (const [name, count, detail] of [
    ["Unanswerable", countIf(r => !r.answerable), "VizWiz answerability label"],
    ["Blur", countIf(r => r.quality_votes.BLR >= 3), "At least 3 of 5 quality votes"],
    ["Framing", countIf(r => r.quality_votes.FRM >= 3), "At least 3 of 5 quality votes"],
    ["Text-heavy", countIf(r => r.text_heavy === "yes"), "Documented OCR or manual rule"],
  ]) source.append(chartRow(name, count, total, detail));
  const coverage = node("section", "chart-panel");
  coverage.append(node("h4", "", "Which model answers are available"));
  const answered = (r, p) => r.models[p]?.answer?.status === "success";
  for (const [name, count] of [
    ["Closed model", countIf(r => answered(r, "codex"))],
    ["Open model", countIf(r => answered(r, "ollama"))],
    ["Both models", countIf(r => answered(r, "codex") && answered(r, "ollama"))],
    ["Neither model", countIf(r => !answered(r, "codex") && !answered(r, "ollama"))],
  ]) coverage.append(chartRow(name, count, total));
  coverage.append(node("p", "chart-detail", "Availability is a run-status count; it does not say whether an answer is correct or useful."));
  grid.append(source, coverage); target.append(grid);
}

async function start() {
  try {
    const response = await fetch("api/explorer.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    if (!state.data.records?.length) throw new Error("No selected records");
    try {
      const saved = localStorage.getItem(AUDIT_KEY);
      if (saved) state.audits = validateAuditFile(JSON.parse(saved), state.data);
    } catch (error) { state.auditMessage = `Saved review could not be loaded: ${error.message}`; }
    if (["public_reviewed", "public_wip"].includes(state.data.mode)) {
      byId("mode-badge").textContent = state.data.mode === "public_wip" ? "Public work in progress" : "Reviewed public subset";
      byId("mode-note").textContent = state.data.mode === "public_wip" ? "Public work in progress · photographs load from VizWiz." : `${state.data.sample.selected} of ${state.data.sample.originally_selected} selected images passed privacy review for this public subset.`;
    }
    renderSummary(); renderRecord();
    const hash = location.hash.slice(1);
    setView(["voices", "breaks", "next"].includes(hash) ? hash : "voices");
    byId("previous").addEventListener("click", () => setIndex(state.index - 1));
    byId("next-record").addEventListener("click", () => setIndex(state.index + 1));
    byId("record-search").addEventListener("input", event => { state.search = event.target.value; renderSearch(); });
    for (const tab of document.querySelectorAll(".view-tab")) tab.addEventListener("click", () => setView(tab.dataset.view));
  } catch (error) {
    byId("summary").textContent = `Could not load the local dataset: ${error.message}`;
  }
}

function filterRecords() {
  const f = state.filters;
  return state.data.records.map((record, index) => ({ record, index })).filter(({ record }) => {
    const query = state.tableSearch.trim().toLowerCase();
    if (query && ![record.image, record.question,
      ...record.captions.map(item => item.caption), ...record.answers.map(item => item.answer),
      ...["codex", "ollama"].flatMap(provider => [record.models[provider]?.description?.text || "", record.models[provider]?.answer?.text || ""])
    ].some(value => String(value).toLowerCase().includes(query))) return false;
    if (f.blur && record.quality_votes.BLR < 3) return false;
    if (f.framing && record.quality_votes.FRM < 3) return false;
    if (f.textHeavy && record.text_heavy !== "yes") return false;
    if (f.unanswerable && record.answerable !== 0) return false;
    if (f.stakes !== "all" && record.stakes !== f.stakes) return false;
    if (f.answered) {
      const providers = f.provider === "all" ? ["codex", "ollama"] : [f.provider];
      if (!providers.some(provider => record.models[provider]?.answer?.status === "success")) return false;
    }
    if (f.needsAudit && completeAuditCount(record.image) === 2) return false;
    return true;
  });
}

function filterCheckbox(parent, key, title, detail) {
  const wrapper = node("label", "filter-option");
  const input = node("input"); input.type = "checkbox"; input.checked = state.filters[key];
  input.addEventListener("change", () => { state.filters[key] = input.checked; state.filterLimit = 50; renderFilterResults(); });
  const text = node("span"); text.append(node("strong", "", title)); text.append(node("small", "", detail));
  wrapper.append(input, text); parent.append(wrapper);
}

function filterSelect(parent, key, title, options) {
  const wrapper = node("label", "filter-select", title);
  const select = node("select");
  for (const [value, name] of options) {
    const option = node("option", "", name); option.value = value; select.append(option);
  }
  select.value = state.filters[key];
  select.addEventListener("change", () => { state.filters[key] = select.value; state.filterLimit = 50; renderFilterResults(); });
  wrapper.append(select); parent.append(wrapper);
}

function renderFilters() {
  const target = byId("filter-app"); clear(target);
  const controls = node("div", "filter-controls");
  const intro = node("p", "filter-explain", "Search and filter the complete selected sample. A match is a condition, not a measured model failure.");
  controls.append(intro);
  const search = node("label", "filter-select", "Search questions, captions, answers, model text, or filename");
  const searchInput = node("input"); searchInput.type = "search";
  searchInput.placeholder = "Search all records…"; searchInput.value = state.tableSearch;
  searchInput.addEventListener("input", () => { state.tableSearch = searchInput.value; state.filterLimit = 50; renderFilterResults(); });
  search.append(searchInput); controls.append(search);
  const group = node("div", "filter-checks");
  filterCheckbox(group, "blur", "Blur", "At least 3 of 5 quality votes");
  filterCheckbox(group, "framing", "Framing", "At least 3 of 5 quality votes");
  filterCheckbox(group, "textHeavy", "Text-heavy image", "OCR rule or image review: yes");
  filterCheckbox(group, "unanswerable", "Unanswerable", "VizWiz source label");
  filterCheckbox(group, "answered", "Has a model answer", "Only completed answer calls");
  filterCheckbox(group, "needsAudit", "Needs analyst review", "Fewer than two models fully reviewed");
  controls.append(group);
  const selects = node("div", "filter-selects");
  filterSelect(selects, "stakes", "Question topic", [["all", "All topics"], ["medication", "Medication"], ["food_safety", "Food safety"], ["money", "Money"], ["other", "Everything else"]]);
  filterSelect(selects, "provider", "For ‘Has a model answer’", [["all", "Either model"], ["codex", "Closed model"], ["ollama", "Open model"]]);
  controls.append(selects);
  target.append(controls);
  const results = node("div"); results.id = "filter-results"; target.append(results);
  renderFilterResults();
}

function renderFilterResults() {
  const target = byId("filter-results"); if (!target) return; clear(target);
  const matches = filterRecords();
  const count = node("div", "filter-count");
  count.append(node("strong", "", `${matches.length} of ${state.data.sample.selected}`));
  count.append(node("span", "", "selected images match this search and these conditions"));
  target.append(count);
  const auditTools = node("div", "audit-tools");
  const auditStatus = node("p", "", `${state.data.records.filter(r => completeAuditCount(r.image) === 2).length} of ${state.data.records.length} images reviewed for both models. Reviews stay in this browser until you export them.`);
  const exportButton = node("button", "download-data", "Export analyst reviews (JSON)"); exportButton.type = "button";
  exportButton.addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(auditFile(state.data, state.audits), null, 2)], { type: "application/json" }));
    const link = node("a"); link.href = url; link.download = "what-ai-fails-to-see-reviews.json";
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const importLabel = node("label", "audit-import", "Import analyst reviews (JSON)");
  const importInput = node("input"); importInput.type = "file"; importInput.accept = "application/json,.json";
  importInput.addEventListener("change", async () => {
    const file = importInput.files?.[0]; if (!file) return;
    try {
      const ratings = validateAuditFile(JSON.parse(await file.text()), state.data);
      state.audits = ratings; saveAudits(); state.auditMessage = "Imported reviews for this sample and these model versions.";
      renderRecord(); renderOverview(); renderFilterResults();
    } catch (error) { state.auditMessage = `Import failed: ${error.message}`; renderAuditStatus(); renderFilterResults(); }
  });
  importLabel.append(importInput); auditTools.append(auditStatus, exportButton, importLabel);
  if (state.auditMessage) auditTools.append(node("p", "audit-message", state.auditMessage));
  target.append(auditTools);
  const download = node("button", "download-data", `Download ${matches.length} matching records (JSON)`);
  download.type = "button"; download.disabled = matches.length === 0;
  download.addEventListener("click", () => {
    const data = { schema_version: state.data.schema_version, mode: state.data.mode,
      sample: state.data.sample, exported_records: matches.length,
      note: "Filtered explorer records. Counts describe the selected sample, not population rates.",
      records: matches.map(({ record }) => record) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const link = node("a"); link.href = url; link.download = "what-ai-fails-to-see-filtered.json";
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  target.append(download);
  if (state.filters.textHeavy && state.data.summary.text_heavy_reviewed === 0) {
    target.append(node("p", "filter-note", "No images have been scored for text density yet. The VizWiz ‘text detected’ flag is a separate crowd label and is not used as a text-heavy label."));
  } else {
    target.append(node("p", "filter-note", `Text-heavy status is known for ${state.data.summary.text_heavy_reviewed} of ${state.data.sample.selected} selected images. Unknown images are excluded when that filter is on.`));
  }
  if (!matches.length) { target.append(node("p", "empty-filter", "No images match. Try removing a filter.")); return; }
  const tableWrap = node("div", "index-scroll");
  const table = node("table", "index-table");
  const caption = node("caption", "", "Matching records with source labels and both model answers");
  const thead = node("thead"); const header = node("tr");
  for (const title of ["Image", "Question", "Source labels", "Closed answer", "Open answer", "Review", "Inspect"])
    header.append(node("th", "", title));
  thead.append(header); table.append(caption, thead);
  const body = node("tbody");
  for (const { record, index } of matches.slice(0, state.filterLimit)) {
    const row = node("tr");
    row.append(node("td", "filename", record.image));
    row.append(node("td", "index-question", record.question));
    const tags = [record.stakes.replace("_", " ")];
    if (!record.answerable) tags.push("Unanswerable");
    if (record.quality_votes.BLR >= 3) tags.push("Blur");
    if (record.quality_votes.FRM >= 3) tags.push("Framing");
    if (record.text_heavy === "yes") tags.push("Text-heavy");
    row.append(node("td", "index-tags", tags.join(" · ")));
    for (const provider of ["codex", "ollama"]) {
      const answer = record.models[provider]?.answer;
      row.append(node("td", "index-answer", answer?.status === "success" ? answer.text : `(${answer?.status || "not run"})`));
    }
    row.append(node("td", "index-review", `${completeAuditCount(record.image)} / 2 models`));
    const open = node("button", "open-record", "Compare this image →"); open.type = "button";
    open.addEventListener("click", () => { setIndex(index); setView("voices"); byId("voices-title").scrollIntoView({ block: "start" }); });
    const action = node("td"); action.append(open); row.append(action); body.append(row);
  }
  table.append(body); tableWrap.append(table); target.append(tableWrap);
  if (matches.length > state.filterLimit) {
    const more = node("button", "show-more", `Show more (${matches.length - state.filterLimit} remaining)`);
    more.type = "button";
    more.addEventListener("click", () => { state.filterLimit += 50; renderFilterResults(); });
    target.append(more);
  }
  target.append(node("p", "sample-caveat", "Counts describe this selected explorer sample. They are not population failure rates or severity estimates."));
}
function externalLink(text, href) {
  const link = node("a", "", text); link.href = href; link.target = "_blank";
  link.rel = "noopener noreferrer"; return link;
}

function renderEditorial() {
  const target = byId("editorial"); clear(target);
  const lead = node("div", "editorial-lead");
  lead.append(node("p", "eyebrow", "AN OPEN QUESTION"));
  lead.append(node("p", "lead-line", "What changes when an answer is about a pill, an expiration date, or money?"));
  lead.append(node("p", "", "A plausible description can leave the person’s specific decision unanswered. This explorer lets us inspect that gap, but it does not measure real-world consequences."));
  target.append(lead);

  const cards = node("div", "stakes-grid");
  const topics = [
    ["medication", "Medication", "Would the assistant name a medicine when a label is unclear? When should it ask for another photo or a human check?"],
    ["food_safety", "Food safety", "Can a model reliably read an expiration date or food-safety cue, and communicate when it cannot?"],
    ["money", "Money", "What happens when a price, bill, coupon, or stored-value code is read incorrectly?"],
  ];
  for (const [key, title, question] of topics) {
    const card = node("article", "stakes-card");
    card.append(node("span", "stakes-number", String(state.data.summary.stakes[key] || 0).padStart(2, "0")));
    card.append(node("span", "stakes-unit", "questions in this selected sample"));
    card.append(node("h3", "", title));
    card.append(node("p", "", question)); cards.append(card);
  }
  target.append(cards);

  const context = node("div", "editorial-context");
  const primary = node("article");
  primary.append(node("p", "eyebrow", "WHY STUDY SEVERITY AND TRUST"));
  primary.append(node("h3", "", "The cost of an error depends on the task."));
  const first = node("p"); first.append("Hong and Kacorri’s study of blind and low-vision people using object recognition found that participants identified about half of the system’s errors in a controlled task. It discusses why error detection and confidence matter in assistive interfaces. ");
  first.append(externalLink("Read the study", "https://pmc.ncbi.nlm.nih.gov/articles/PMC11872236/")); primary.append(first);
  const second = node("p"); second.append("Alharbi and colleagues describe how blind people verify and contest AI errors across everyday situations. Their work motivates studying when a person can check a model’s claim and when a confident-sounding answer might be overtrusted. ");
  second.append(externalLink("Read the paper", "https://arxiv.org/abs/2408.06546")); primary.append(second);
  context.append(primary);
  const limit = node("aside", "editorial-limit");
  limit.append(node("p", "eyebrow", "WHAT THIS DATA CAN SAY"));
  limit.append(node("h3", "", "A question topic is not a harm score."));
  limit.append(node("p", "", "Our tags use question text alone. The sample is 300 images selected for exploration, and the high-stakes categories are small. We have not observed user decisions, downstream harm, or error severity. The filters reveal cases to inspect, not population rates."));
  limit.append(externalLink("Read the labeling rules", "https://github.com/isha-talegaonkar/what-ai-fails-to-see/blob/main/docs/LABELING.md"));
  context.append(limit); target.append(context);
  const next = node("div", "next-study");
  next.append(node("p", "eyebrow", "A TECHNICAL AUDIT TO TRY"));
  next.append(node("h3", "", "Review outputs against the original question."));
  next.append(node("p", "", "Use the analyst review above to label whether each generic description addresses the question, whether each direct answer is supported by the image, and what follow-up is warranted. Compare these judgments with answerability and image-quality labels. Report disagreements and uncertain cases explicitly. Topic tags invite close inspection; they do not measure harm."));
  target.append(next);
}
if (typeof document !== "undefined") start();
if (typeof module !== "undefined") module.exports = { auditModelIds, validateAuditFile, auditFile };
