"use strict";
let KEY = sessionStorage.getItem("inst_key") || "";
let editingId = null;

const $ = s => document.querySelector(s);
const toast = m => { const t = $("#toast"); t.textContent = m; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 2400); };
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = d => new Date(d).toLocaleString();
// NOTE: dateStyle/timeStyle CANNOT be combined with timeZoneName (throws) — use explicit components.
const fmtTZ = d => new Date(d).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" });
const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
// word-level diff of original (spoken) vs submitted text → HTML with <del>/<ins>
function wordDiff(oldStr, newStr) {
  const a = (oldStr || "").split(/(\s+)/), b = (newStr || "").split(/(\s+)/);
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0, out = "";
  while (i < m && j < n) {
    if (a[i] === b[j]) { out += esc(b[j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { if (a[i].trim()) out += `<del>${esc(a[i])}</del>`; i++; }
    else { out += b[j].trim() ? `<ins>${esc(b[j])}</ins>` : esc(b[j]); j++; } // keep inserted spaces
  }
  while (i < m) { if (a[i].trim()) out += `<del>${esc(a[i])}</del>`; i++; }
  while (j < n) { out += b[j].trim() ? `<ins>${esc(b[j])}</ins>` : esc(b[j]); j++; }
  return out;
}

function headers(extra) { return Object.assign({ "x-instructor-key": KEY }, extra || {}); }
async function api(path, opts) {
  const r = await fetch(path, Object.assign({ headers: headers(opts && opts.json ? { "Content-Type": "application/json" } : {}) }, opts || {}));
  if (r.status === 401) { showLogin(); throw new Error("unauthorized"); }
  return r;
}

// ---------- tabs ----------
document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => switchView(b.dataset.view)));
function switchView(name) {
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + name));
  if (name === "assignments") loadAssignments();
  if (name === "submissions") { loadSubmissions(); startSubsAutoRefresh(); } else { stopSubsAutoRefresh(); }
}

// ---- live "recording now" indicator (auto-refreshes while on the Submissions tab) ----
let subsRefreshTimer = null;
function startSubsAutoRefresh() { stopSubsAutoRefresh(); subsRefreshTimer = setInterval(refreshSubsQuietly, 15000); }
function stopSubsAutoRefresh() { if (subsRefreshTimer) { clearInterval(subsRefreshTimer); subsRefreshTimer = null; } }
async function refreshSubsQuietly() {
  // re-fetch + re-render the list and active banner WITHOUT closing an open submission
  try { allSubs = await (await api("/api/submissions")).json(); renderSubs(); updateActiveNow(); } catch {}
}
function updateActiveNow() {
  const el = $("#active-now"); if (!el) return;
  const cutoff = Date.now() - 90000; // "active" = an in-progress session that pinged in the last 90s
  const live = allSubs.filter(s => s.status === "in-progress" && s.endedAt && s.endedAt > cutoff);
  if (live.length) {
    el.innerHTML = `<div class="banner warn">🔴 <strong>${live.length} student(s) recording right now</strong>: ${live.map(s => esc(s.studentName || "?")).join(", ")}. Don't restart or redeploy until they finish.</div>`;
  } else {
    el.innerHTML = `<div class="banner ok">✓ No one is recording right now — safe to restart / redeploy. <span class="footnote">(updates every 15s)</span></div>`;
  }
}

// ---------- boot / login ----------
(async function boot() {
  const h = await (await fetch("/api/health")).json();
  const sb = $("#status-banner");
  if (!h.hasKey) sb.innerHTML = `<div class="banner warn">⚠️ No Anthropic API key yet — conversations won't run. Add your key to the <code>.env</code> file and restart the app. Everything else works for setup.</div>`;
  else sb.innerHTML = `<div class="banner info">Model: <strong>${esc(h.model)}</strong>. Ready.</div>`;
  if (h.needsPassword && !KEY) showLogin();
})();
function showLogin() {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  $("#view-login").classList.add("active");
}
$("#login-btn").addEventListener("click", async () => {
  const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: $("#login-pw").value }) });
  if (!r.ok) return toast("Wrong password");
  const d = await r.json(); KEY = d.token || ""; sessionStorage.setItem("inst_key", KEY);
  switchView("create");
});

// ---------- create form ----------
$("#src-toggle").addEventListener("click", e => {
  const btn = e.target.closest("button"); if (!btn) return;
  $("#src-toggle").querySelectorAll("button").forEach(b => b.classList.toggle("on", b === btn));
  $("#src-pdf").style.display = btn.dataset.src === "pdf" ? "block" : "none";
  $("#src-text").style.display = btn.dataset.src === "text" ? "block" : "none";
});
function currentSrc() { return $("#src-toggle .on").dataset.src; }

const drop = $("#drop"), fpdf = $("#f-pdf");
drop.addEventListener("click", () => fpdf.click());
["dragover", "dragenter"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("hot"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("hot"); }));
drop.addEventListener("drop", e => { if (e.dataTransfer.files[0]) { fpdf.files = e.dataTransfer.files; showPdfName(); } });
fpdf.addEventListener("change", showPdfName);
function showPdfName() { const f = fpdf.files[0]; $("#pdf-name").textContent = f ? "Selected: " + f.name : ""; }

$("#f-text").addEventListener("input", () => {
  const v = $("#f-text").value.trim();
  $("#text-wc").textContent = (v ? v.split(/\s+/).length.toLocaleString() : 0) + " words";
});
$("#f-tuning").addEventListener("change", () => {
  $("#concepts-box").style.display = $("#f-tuning").value === "concepts" ? "block" : "none";
});

$("#reset-btn").addEventListener("click", resetForm);
function resetForm() {
  editingId = null;
  ["f-title", "f-text", "f-c1", "f-c2", "f-c3", "f-c4", "f-c5", "f-c6", "f-start", "f-end"].forEach(id => { const el = $("#" + id); if (el) el.value = ""; });
  $("#pdf-name").textContent = ""; fpdf.value = ""; $("#text-wc").textContent = "";
  $("#edit-note").textContent = "";
}

$("#save-btn").addEventListener("click", async () => {
  const title = $("#f-title").value.trim();
  if (!title) return toast("Add a title");
  const fd = new FormData();
  if (editingId) fd.append("id", editingId);
  fd.append("title", title);
  fd.append("subject", $("#f-subject").value);
  fd.append("gradeLevel", $("#f-grade").value);
  fd.append("tuning", $("#f-tuning").value);
  for (let i = 1; i <= 6; i++) fd.append("concept" + i, $("#f-c" + i).value);
  fd.append("maxQuestions", $("#f-maxq").value);
  fd.append("minWords", $("#f-minwords").value);
  fd.append("requireCamera", $("#f-camera").value);
  fd.append("avOptional", $("#f-avoptional").value);
  fd.append("coachMode", $("#f-coachmode").value);
  fd.append("feedbackMode", $("#f-feedback").value);
  fd.append("showReading", $("#f-showreading").value);
  fd.append("waitingTime", $("#f-waiting").value);
  fd.append("answerLimit", $("#f-answerlimit").value);
  fd.append("answerWindow", $("#f-answerwindow").value);
  fd.append("requireStudentWork", $("#f-studentwork").value);
  fd.append("finalQuestion", $("#f-finalq").value);

  if (currentSrc() === "pdf") {
    if (!fpdf.files[0] && !editingId) return toast("Choose a PDF (or switch to Paste text)");
    if (fpdf.files[0]) fd.append("pdf", fpdf.files[0]);
    if ($("#f-start").value) fd.append("startPage", $("#f-start").value);
    if ($("#f-end").value) fd.append("endPage", $("#f-end").value);
  } else {
    const t = $("#f-text").value.trim();
    if (!t && !editingId) return toast("Paste the module material text");
    fd.append("readingText", t);
  }

  $("#save-btn").disabled = true; $("#save-btn").textContent = "Saving…";
  try {
    const r = await api("/api/assignments", { method: "POST", body: fd });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "save failed");
    toast(editingId ? "Updated" : "Saved" + (d.wordCount ? ` · ${d.wordCount.toLocaleString()} words read` : ""));
    if (d.conceptWarnings && d.conceptWarnings.length) {
      alert("Saved — but heads up: the source document doesn't appear to cover these concept(s):\n\n• " +
        d.conceptWarnings.join("\n• ") +
        "\n\nThe coach can only ask about what's in the source doc, so add coverage for these (or check the wording matches) before students start.");
    }
    resetForm(); switchView("assignments");
  } catch (e) { toast(e.message); }
  finally { $("#save-btn").disabled = false; $("#save-btn").textContent = "Save assignment"; }
});

// ---------- assignments ----------
async function loadAssignments() {
  const box = $("#assignment-list");
  const list = await (await api("/api/assignments")).json();
  if (!list.length) { box.innerHTML = `<div class="empty">No assignments yet.</div>`; return; }
  box.innerHTML = "";
  list.forEach(a => {
    const link = location.origin + "/student.html?a=" + a.id;
    const el = document.createElement("div");
    el.className = "list-item";
    el.innerHTML = `<div style="flex:1">
        <div style="font-weight:650">${esc(a.title)}</div>
        <div class="meta">${esc(a.subject || "")} · ${a.wordCount ? a.wordCount.toLocaleString() + " words" : "no text"} · ${a.tuning === "concepts" ? (a.concepts.length + " concept(s)") : "AI-driven"} · ${a.responseCount} submission(s)</div></div>`;
    const mk = (t, cls, fn) => { const b = document.createElement("button"); b.className = "btn " + cls; b.textContent = t; b.style.fontSize = "13px"; b.onclick = fn; return b; };
    el.append(
      mk("Copy student link", "ghost", () => navigator.clipboard.writeText(link).then(() => toast("Link copied"))),
      mk("Edit", "subtle", () => editAssignment(a.id)),
      mk("Delete", "danger", async () => { if (confirm("Delete this assignment? Submissions are kept.")) { await api("/api/assignments/" + a.id, { method: "DELETE" }); loadAssignments(); } })
    );
    box.appendChild(el);
  });
}
async function editAssignment(id) {
  const a = (await (await api("/api/assignments")).json()).find(x => x.id === id);
  if (!a) return;
  editingId = id; switchView("create");
  $("#f-title").value = a.title; $("#f-subject").value = a.subject || "Communication"; $("#f-grade").value = a.gradeLevel || "College";
  $("#f-tuning").value = a.tuning; $("#f-tuning").dispatchEvent(new Event("change"));
  for (let i = 0; i < 6; i++) $("#f-c" + (i + 1)).value = a.concepts[i] || "";
  $("#f-maxq").value = a.maxQuestions; $("#f-minwords").value = a.minWords;
  $("#f-camera").value = String(a.requireCamera); $("#f-feedback").value = a.feedbackMode;
  $("#f-avoptional").value = a.avOptional ? "1" : "";
  $("#f-coachmode").value = a.coachMode || "assessment";
  $("#f-showreading").value = String(!!a.showReading);
  $("#f-waiting").value = String(a.waitingTime || 0);
  $("#f-answerlimit").value = String(a.answerLimit || 0);
  $("#f-answerwindow").value = String(a.answerWindow || 0);
  $("#f-studentwork").value = String(a.requireStudentWork !== false);
  $("#f-finalq").value = a.finalQuestion || "";
  const mat = a.pageRange ? ("PDF, pages " + a.pageRange) : (a.wordCount ? (a.wordCount.toLocaleString() + " words of text") : "on file");
  $("#edit-note").textContent = "Editing “" + a.title + "”. Its saved material (" + mat + ") is kept automatically — only add a PDF or paste text if you want to REPLACE it.";
  $("#pdf-name").textContent = "✓ Existing material kept (" + mat + ") — no need to re-upload.";
}

// ---------- submissions ----------
let allSubs = [];
$("#export-csv").addEventListener("click", () => {
  if (!allSubs.length) return toast("No submissions to export");
  const sel = $("#sub-filter").value;
  // key passed in the query string because a file download can't carry a custom header
  const url = "/api/submissions.csv?key=" + encodeURIComponent(KEY) + (sel ? "&assignmentId=" + encodeURIComponent(sel) : "");
  window.location = url;
});
$("#export-json").addEventListener("click", () => {
  if (!allSubs.length) return toast("No submissions to export");
  const sel = $("#sub-filter").value;
  window.location = "/api/submissions.json?key=" + encodeURIComponent(KEY) + (sel ? "&assignmentId=" + encodeURIComponent(sel) : "");
});
$("#download-videos").addEventListener("click", () => {
  const sel = $("#sub-filter").value;
  window.location = "/api/videos.zip?key=" + encodeURIComponent(KEY) + (sel ? "&assignmentId=" + encodeURIComponent(sel) : "");
});
$("#purge-videos").addEventListener("click", async () => {
  const sel = $("#sub-filter").value;
  const scope = sel ? "this assignment" : "ALL assignments";
  if (!confirm("Delete the video files for " + scope + "?\n\nTranscripts and grades are KEPT. Make sure you've downloaded the videos first — this can't be undone.")) return;
  const r = await api("/api/purge-videos", { json: true, method: "POST", body: JSON.stringify({ assignmentId: sel || undefined }) });
  const d = await r.json().catch(() => ({}));
  toast(r.ok ? "Deleted " + (d.purged || 0) + " video(s); transcripts kept" : "Failed");
  loadSubmissions();
});
async function loadSubmissions() {
  allSubs = await (await api("/api/submissions")).json();
  const f = $("#sub-filter");
  const titles = {}; allSubs.forEach(s => titles[s.assignmentId] = s.assignmentTitle);
  f.innerHTML = `<option value="">All assignments</option>` + Object.entries(titles).map(([id, t]) => `<option value="${id}">${esc(t)}</option>`).join("");
  f.onchange = renderSubs; renderSubs(); updateActiveNow(); $("#sub-detail").style.display = "none";
}
function renderSubs() {
  const sel = $("#sub-filter").value;
  const rows = (sel ? allSubs.filter(s => s.assignmentId === sel) : allSubs);
  const box = $("#submission-list");
  if (!rows.length) { box.innerHTML = `<div class="empty">No submissions yet.</div>`; return; }
  box.innerHTML = "";
  rows.forEach(s => {
    const el = document.createElement("div"); el.className = "list-item";
    const fb = (s.status === "in-progress" ? `<span class="pill warn">⏳ incomplete</span> ` : "") + (s.grade != null && s.grade !== "" ? `<span class="pill good">grade: ${esc(s.grade)}</span> ` : (s.suggestedScore != null ? `<span class="pill muted">suggested: ${s.suggestedScore}</span> ` : "")) + (s.attemptNumber > 1 ? `<span class="pill muted">🔁 redo #${s.attemptNumber}</span> ` : "") + (s.avStatus === "missing" ? `<span class="pill warn">🎥 no AV</span> ` : (s.avStatus === "partial" ? `<span class="pill warn">🎥 partial AV</span> ` : "")) + (s.flaggedPaste ? `<span class="pill warn">⚠ pasted</span> ` : "") + (s.flaggedEdited ? `<span class="pill warn">✎ edited</span> ` : "") + (s.tabAway ? `<span class="pill warn">👁 away ${s.tabAway}×</span> ` : "") + (s.copies ? `<span class="pill warn">⎘ copied ${s.copies}×</span> ` : "") + (s.feedbackApproved ? `<span class="pill good">shared</span>` : "");
    el.innerHTML = `<div style="flex:1"><div style="font-weight:650">${esc(s.studentName)} ${s.studentId ? `<span class="meta">(${esc(s.studentId)})</span>` : ""}</div>
      <div class="meta">${s.studentEmail ? esc(s.studentEmail) + " · " : ""}${esc(s.assignmentTitle)} · ${fmt(s.submittedAt)} · ${s.hasVideo ? "🎥 video" : (s.videoPurgedAt ? "video offloaded" : "no video")}</div></div> ${fb}`;
    const open = document.createElement("button"); open.className = "btn subtle"; open.textContent = "Open"; open.style.fontSize = "13px";
    open.onclick = () => openSub(s.id); el.appendChild(open);
    box.appendChild(el);
  });
}
// Build the "who was talking when" breakdown from the per-turn timestamps the student page now records:
//   coach turns carry spokenStart/EndOffsetMs; student turns carry firstWord/lastWord/submit offsets.
// Everything is measured from the recording clock, so no audio analysis is needed. Older sessions that
// predate this capture won't have the fields — we return "" and the section simply doesn't show.
function timeBreakdown(s, hist) {
  let coachTotal = 0, speakTotal = 0, silentBeforeTotal = 0, silentAfterTotal = 0;
  let haveCoach = false, haveAfter = false, qn = 0;
  const rows = [];
  for (let i = 0; i < hist.length; i++) {
    const h = hist[i];
    if (h.role !== "tutor") continue;
    const cEnd = h.spokenEndOffsetMs, cStart = h.spokenStartOffsetMs;
    if (cStart != null && cEnd != null && cEnd >= cStart) { coachTotal += cEnd - cStart; haveCoach = true; }
    const stu = hist.slice(i + 1).find(x => x.role === "student");
    if (!stu) continue; // e.g. the coach's closing line — its talk time counts, but there's no answer row
    qn++;
    const started = stu.firstWordOffsetMs, stopped = stu.lastWordOffsetMs, submitted = stu.videoOffsetMs;
    let sBefore = null, sAfter = null;
    if (cEnd != null && started != null && started >= cEnd) { sBefore = started - cEnd; silentBeforeTotal += sBefore; }
    if (stopped != null && submitted != null && submitted >= stopped) { sAfter = submitted - stopped; silentAfterTotal += sAfter; haveAfter = true; }
    if (started != null && stopped != null && stopped >= started) speakTotal += stopped - started;
    rows.push({ qn, cEnd, started, sBefore, stopped, submitted, sAfter });
  }
  if (!haveCoach && !haveAfter) return ""; // no new-format timing on this session
  const recorded = (s.startedAt && s.endedAt && s.endedAt > s.startedAt) ? (s.endedAt - s.startedAt) : null;
  const pct = ms => (recorded && ms != null) ? ` <span class="meta">(${Math.round(ms / recorded * 100)}%)</span>` : "";
  const cell = (ms, opts = {}) => {
    const bg = opts.silent ? ";background:#f9ecec" : "";
    const bold = (opts.silent && ms != null && ms >= 60000) ? ";font-weight:700" : "";
    return `<td style="border:1px solid var(--line,#d8d5cf);padding:5px 9px;text-align:center;font-variant-numeric:tabular-nums${bg}${bold}">${ms == null ? "—" : mmss(ms)}</td>`;
  };
  const th = (label, silent) => `<th style="border:1px solid var(--line,#d8d5cf);padding:6px 9px;background:${silent ? "#f0d9d9" : "#ece9e2"};font-weight:700;font-size:12px">${label}</th>`;
  const perQ = rows.map(r => `<tr>
      <td style="border:1px solid var(--line,#d8d5cf);padding:5px 9px;text-align:center;font-weight:700">${r.qn}</td>
      ${cell(r.cEnd)}${cell(r.started)}${cell(r.sBefore, { silent: true })}${cell(r.stopped)}${cell(r.submitted)}${cell(r.sAfter, { silent: true })}
    </tr>`).join("");
  const totalRow = `<tr>
      <td colspan="3" style="border:1px solid var(--line,#d8d5cf);padding:6px 9px;text-align:right;font-weight:700;background:#ece9e2">Total</td>
      <td style="border:1px solid var(--line,#d8d5cf);padding:6px 9px;text-align:center;font-weight:700;background:#f0d9d9;font-variant-numeric:tabular-nums">${mmss(silentBeforeTotal)}</td>
      <td colspan="2" style="border:1px solid var(--line,#d8d5cf);background:#ece9e2"></td>
      <td style="border:1px solid var(--line,#d8d5cf);padding:6px 9px;text-align:center;font-weight:700;background:#f0d9d9;font-variant-numeric:tabular-nums">${mmss(silentAfterTotal)}</td>
    </tr>`;
  const totals = `<ul style="margin:6px 0 12px;list-style:none;padding:0;line-height:1.7">
      ${recorded != null ? `<li><strong>Total recorded:</strong> ${mmss(recorded)}</li>` : ""}
      <li><strong>Coach talking</strong> (reading questions + closing): ${mmss(coachTotal)}${pct(coachTotal)}</li>
      <li><strong>Student answering</strong> (first word → last word): ${mmss(speakTotal)}${pct(speakTotal)} <span class="footnote">— includes pauses within answers, so it's not pure speech time</span></li>
      <li>Silent after a question, <strong>before the student spoke</strong>: ${mmss(silentBeforeTotal)}${pct(silentBeforeTotal)}</li>
      <li style="color:var(--warn)">Silent after answering, <strong>before submitting</strong>: ${mmss(silentAfterTotal)}${pct(silentAfterTotal)} <span class="footnote" style="color:var(--muted)">— dead time; a long total here is worth a look</span></li>
    </ul>`;
  return `<details style="margin:6px 0 14px"><summary style="cursor:pointer;font-weight:700;font-size:16px">⏱ Time breakdown — who was talking when</summary>
    <div style="margin-top:8px">
      ${totals}
      <div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:13px">
        <tr>${th("Q")}${th("Coach done<br>reading")}${th("Student<br>started")}${th("Silent<br>before", true)}${th("Student<br>stopped")}${th("Submitted")}${th("Silent<br>after", true)}</tr>
        ${perQ}${totalRow}
      </table></div>
      <p class="footnote" style="margin-top:6px">Times are positions in the recording. <strong>Silent before</strong> = coach finished reading but the student hadn't started talking. <strong>Silent after</strong> = student finished talking but hadn't clicked Send yet.</p>
    </div></details>`;
}
async function openSub(id) {
  const d = $("#sub-detail");
  try {
  const r = await api("/api/submissions/" + id);
  if (!r.ok) throw new Error("server returned " + r.status);
  const s = await r.json();
  const hist = Array.isArray(s.history) ? s.history : [];
  const dur = (s.startedAt && s.endedAt) ? ` · lasted ${mmss(s.endedAt - s.startedAt)}` : "";
  const startStr = s.startedAt ? fmtTZ(s.startedAt) : fmtTZ(s.submittedAt);

  let maxGapMs = 0;
  const questions = []; // each Coach turn = a navigable "question" for the jump bar
  const transcript = hist.map((h, i) => {
    const who = h.role === "tutor" ? "Coach" : esc(s.studentName);
    let lineId = "";
    if (h.role === "tutor") {
      const offSec = (s.hasVideo && h.videoOffsetMs != null) ? Math.round(h.videoOffsetMs / 1000) : null;
      lineId = `tl-${i}`;
      questions.push({ qn: questions.length + 1, lineId, offSec });
    }
    const t = h.at ? `<span class="meta"> · ${fmtTZ(h.at)}</span>` : "";
    const jump = (s.hasVideo && h.videoOffsetMs != null)
      ? ` <a href="#" class="vjump" data-off="${Math.round(h.videoOffsetMs / 1000)}">▶ ${mmss(h.videoOffsetMs)}</a>` : "";
    let resp = "";
    if (h.role === "student" && h.at && i > 0 && hist[i - 1].role === "tutor" && hist[i - 1].at) {
      const prevAt = hist[i - 1].at;
      // measure the pause from when the mic opened (coach done reading the question aloud) if we have it;
      // otherwise fall back to when the question was shown (older sessions — that includes the coach's speaking time)
      const pauseBase = (h.readyAt && h.firstWordAt && h.firstWordAt >= h.readyAt) ? h.readyAt : prevAt;
      const isTrue = !!(h.readyAt && h.firstWordAt && h.firstWordAt >= h.readyAt);
      if (h.firstWordAt && h.firstWordAt >= pauseBase && h.firstWordAt <= h.at) {
        // split the wait into the SILENT pause before they spoke, and how long they then spoke
        const pause = h.firstWordAt - pauseBase, spoke = h.at - h.firstWordAt;
        if (pause > maxGapMs) maxGapMs = pause;
        const longish = pause > 120000; // > 2 min of silence before a word — worth a look
        const fwJump = (s.hasVideo && h.firstWordOffsetMs != null) ? ` <a href="#" class="vjump" data-off="${Math.round(h.firstWordOffsetMs / 1000)}">▶</a>` : "";
        const note = isTrue ? "" : " (incl. coach reading the question)";
        resp = ` <span class="meta" style="${longish ? "color:var(--warn);font-weight:700" : ""}">⏱ paused ${mmss(pause)} before speaking${note}${fwJump} · then spoke ${mmss(spoke)}</span>`;
      } else {
        // older submissions (no first-word capture): fall back to the single total
        const gap = h.at - prevAt;
        if (gap > maxGapMs) maxGapMs = gap;
        const longish = gap > 180000;
        resp = ` <span class="meta" style="${longish ? "color:var(--warn);font-weight:700" : ""}">⏱ ${mmss(gap)} to answer</span>`;
      }
    }
    let edited = "";
    if (h.role === "student" && h.edited && h.spoken) {
      edited = `<div class="meta" style="margin:4px 0 0 14px;padding-left:8px;border-left:2px solid var(--warn)">`
        + `<span class="pill warn">✎ student-edited</span> The student manually changed the auto-transcript. Auto-transcribed speech was: “${esc(h.spoken)}”`
        + `<div style="margin-top:2px">their changes: ${wordDiff(h.spoken, h.text)}</div></div>`;
    }
    // per-question audio backup player (this answer's own clip, uploaded live during the session)
    let segPlayer = "";
    if (h.role === "student" && Array.isArray(s.segmentQs) && s.segmentQs.includes(questions.length)) {
      segPlayer = `<div style="margin:5px 0 2px 14px"><span class="footnote">🔊 audio backup of this answer: </span><audio controls preload="none" src="/api/segment/${s.id}/${questions.length}?key=${encodeURIComponent(KEY)}" style="height:30px;vertical-align:middle;max-width:320px"></audio></div>`;
    }
    return `<div class="transcript-line"${lineId ? ` id="${lineId}"` : ""}><span class="who">${who}:</span> ${esc(h.text)}${t}${resp}${jump}${edited}${segPlayer}</div>`;
  }).join("");
  const navBar = questions.length ? `<div class="qnav">
      <span class="footnote" style="margin-right:2px">Jump to question:</span>
      <a href="#" class="qchip" id="qprev" title="Previous question">◀</a>
      ${questions.map(q => `<a href="#" class="qchip" data-line="${q.lineId}"${q.offSec != null ? ` data-off="${q.offSec}"` : ""}>Q${q.qn}</a>`).join("")}
      <a href="#" class="qchip" id="qnext" title="Next question">▶</a>
    </div>` : "";
  const longPause = maxGapMs > 180000;
  const watchBits = [
    s.tabAway ? `switched away from the page ${s.tabAway}×` : null,
    s.copies ? `copied text ${s.copies}×` : null,
    (s.pasteEvents && s.pasteEvents.length) ? `pasted ${s.pasteEvents.length}×` : null,
    longPause ? `a long pause before answering (${mmss(maxGapMs)})` : null
  ].filter(Boolean);
  // per-event detail with clickable jumps to that moment in the video
  const off = e => (s.hasVideo && e.videoOffsetMs != null) ? ` <a href="#" class="vjump" data-off="${Math.round(e.videoOffsetMs / 1000)}">▶ ${mmss(e.videoOffsetMs)}</a>` : "";
  const awayDetail = (s.awayEvents || []).map(e => `<li>Left the page for <strong>${mmss(e.durationMs)}</strong>${e.q ? ` (during Q${esc(e.q)})` : ""}${off(e)}</li>`).join("");
  const copyDetail = (s.copyEvents || []).map(e => `<li>Copied: “<em>${esc((e.text || "").trim() || "(nothing was selected)")}</em>”${e.q ? ` (Q${esc(e.q)})` : ""}${off(e)}</li>`).join("");
  const pasteDetail = (s.pasteEvents || []).map(e => `<li>Pasted into the answer: “<em>${esc((e.text || "").trim() || "(empty)")}</em>”${e.q ? ` (Q${esc(e.q)})` : ""}${off(e)}</li>`).join("");
  const integrityDetail = (awayDetail || copyDetail || pasteDetail)
    ? `<div class="banner warn" style="text-align:left">
        ${awayDetail ? `<div><strong>👁 Left the page:</strong></div><ul style="margin:4px 0 8px 18px">${awayDetail}</ul>` : ""}
        ${copyDetail ? `<div><strong>⎘ Copied text:</strong></div><ul style="margin:4px 0 8px 18px">${copyDetail}</ul>` : ""}
        ${pasteDetail ? `<div><strong>📋 Pasted in:</strong></div><ul style="margin:4px 0 0 18px">${pasteDetail}</ul>` : ""}
      </div>` : "";
  // AV status: missing / partial recording, with the gap timestamps (clickable where video exists)
  const gapList = (s.recordingGaps || []).map(g => {
    const span = (g.endOffsetMs != null) ? `${mmss(g.startOffsetMs)}–${mmss(g.endOffsetMs)}` : `from ${mmss(g.startOffsetMs)} to the end`;
    const j = (s.hasVideo && g.startOffsetMs != null) ? ` <a href="#" class="vjump" data-off="${Math.round(g.startOffsetMs / 1000)}">▶</a>` : "";
    return `<li>${esc(g.reason || "capture dropped")} (${span})${j}</li>`;
  }).join("");
  const nSeg = (s.segmentQs || []).length;
  const avBanner = s.avStatus === "missing"
    ? `<div class="banner warn">🎥 <strong>No recording was saved</strong> for this session — there is no video/audio to verify the answers against. Grade on the transcript + behavioral signals, or pull this student into a short live follow-up.</div>`
    : s.avStatus === "partial"
    ? `<div class="banner warn">🎥 <strong>Recording is partial</strong> — ${nSeg ? `the full-session video/audio didn't fully save, but <strong>per-question audio backups for ${nSeg} answer(s)</strong> are available below (🔊 under each answer).` : "capture dropped during the session."}${gapList ? `<ul style="margin:4px 0 0 18px">${gapList}</ul>` : ""} The covered stretches are reliable.</div>`
    : "";
  // setup diagnostics — what the student's browser/mic actually did (most useful for failed/incomplete sessions)
  let setupLine = "";
  if (s.setupInfo) {
    const si = s.setupInfo;
    const bits = [
      "mic permission: " + (si.micPermission || "unknown"),
      "mic captured: " + (si.gotAudioTrack ? "yes" : "NO"),
      "camera: " + (si.gotVideoTrack ? "yes" : "no"),
      "speech recognition started: " + (si.speechStarted ? "yes" : "NO"),
      "recorder started: " + (si.recorderStarted ? "yes" : "NO")
    ];
    if (si.speechError) bits.push("speech error: " + si.speechError);
    const problem = !si.gotAudioTrack || !si.speechStarted || !si.recorderStarted || si.speechError;
    setupLine = `<div class="banner ${problem ? "warn" : "info"}" style="text-align:left"><strong>🖥 Setup:</strong> ${esc(bits.join(" · "))}<div class="footnote" style="margin-top:4px;word-break:break-all">${esc(si.userAgent || "")}</div></div>`;
  }

  d.innerHTML = `<div class="row"><h2 style="margin:0">${esc(s.studentName)}</h2><span class="spacer"></span>
      <a class="btn subtle" style="font-size:13px" href="/api/submissions/${s.id}/export.json?key=${encodeURIComponent(KEY)}">⤓ JSON</a>
      <button class="btn danger" id="del-sub" style="font-size:13px">Delete submission + video</button></div>
    <p class="meta">${esc(s.assignmentTitle)}</p>
    <p class="meta">${s.studentEmail ? "✉ " + esc(s.studentEmail) + " · " : ""}${s.studentId ? "ID " + esc(s.studentId) : ""}</p>
    <p class="meta">🕒 Started ${startStr}${dur} · submitted ${fmtTZ(s.submittedAt)}${s.coachMode ? ` · 🎯 ${s.coachMode === "coaching" ? "coaching mode (coach could correct/teach)" : "assessment mode (coach didn't reveal answers)"}` : ""}${s.attemptNumber > 1 ? ` · 🔁 attempt #${s.attemptNumber} (redo — got different questions)` : ""}</p>
    ${s.status === "in-progress" ? `<div class="banner warn">⏳ <strong>Not submitted.</strong> This attempt was autosaved but never completed — the student likely closed the tab or their device crashed mid-conversation. The partial transcript is below; there's no video or AI feedback for it. They may have a separate completed attempt.</div>` : ""}
    ${s.flaggedPaste ? `<div class="banner warn">⚠ This student <strong>tried to paste text</strong> into the answer box (pasting is blocked, but the attempt and the text are logged below). Compare the transcript against the video.</div>` : ""}
    ${s.flaggedTimeOver ? `<div class="banner warn">⏱ This student <strong>went over the per-answer time limit</strong> on at least one question. A signal to look closer at pacing — not an automatic penalty.</div>` : ""}
    ${s.flaggedEdited ? `<div class="banner warn">✎ This student <strong>manually edited the auto-transcript</strong> of one or more spoken answers (this is a student action, not automatic transcription cleanup). The edited answers below show the original speech-to-text and exactly what the student changed.</div>` : ""}
    ${avBanner}
    ${setupLine}
    ${watchBits.length ? `<div class="banner warn">🔎 <strong>Worth a closer look:</strong> ${watchBits.join(" · ")}. These are signals, not proof — watch the video to judge for yourself.</div>` : ""}
    ${integrityDetail}
    ${navBar}
    ${s.hasVideo ? `<video id="sub-video" controls preload="auto" src="/api/video/${s.id}?key=${encodeURIComponent(KEY)}"></video>
      <div class="row" style="margin:6px 0 16px;align-items:center">
        <a class="btn subtle" style="font-size:13px" href="/api/video/${s.id}?key=${encodeURIComponent(KEY)}" download="${esc((s.studentName || "student").replace(/[^a-z0-9]+/gi, "_"))}_${esc((s.assignmentTitle || "session").replace(/[^a-z0-9]+/gi, "_"))}.webm">⬇ Download this video</a>
        <span class="footnote" style="flex:1">▸ Click a <strong>▶ time</strong> beside any answer (or a <strong>Q#</strong> above) to jump the video there. Download to your external drive to keep it past your retention window, then delete the submission.</span>
      </div>` :
      (s.videoPurgedAt ? `<div class="banner info">Video was offloaded/removed on ${fmtTZ(s.videoPurgedAt)}. Transcript kept below.</div>` : (s.videoError ? `<div class="banner warn">🎥 ${esc(s.videoError)}</div>` : ""))}
    ${s.hasAudio ? `<div style="margin:6px 0 16px"><div class="footnote" style="margin-bottom:4px">🔊 Audio backup${s.hasVideo ? "" : " — no video was captured, but here's the audio of what they said"}:</div><audio controls src="/api/audio/${s.id}?key=${encodeURIComponent(KEY)}" style="width:100%"></audio></div>` : ""}
    ${timeBreakdown(s, hist)}
    ${s.studentWork ? `<details open style="margin:10px 0 16px"><summary style="cursor:pointer;font-weight:650">📝 Student's submitted work${s.studentWork.concept ? " — " + esc(s.studentWork.concept) : ""}</summary>
      <h4 style="margin:10px 0 4px">Conceptual definition</h4><div class="reading-box" style="white-space:pre-wrap">${esc(s.studentWork.definition || "(none)")}</div>
      <h4 style="margin:10px 0 4px">Indicators</h4><div class="reading-box" style="white-space:pre-wrap">${esc(s.studentWork.indicators || "(none)")}</div>
      ${s.studentWork.validity ? `<h4 style="margin:10px 0 4px">Validity &amp; reliability answers</h4><div class="reading-box" style="white-space:pre-wrap">${esc(s.studentWork.validity)}</div>` : ""}
      ${s.studentWork.transcript ? `<details style="margin-top:8px"><summary style="cursor:pointer">Chatbot transcript they submitted</summary><div class="reading-box" style="white-space:pre-wrap">${esc(s.studentWork.transcript)}</div></details>` : ""}
    </details>` : ""}
    <h3>Transcript</h3>
    <p class="footnote" style="margin:-4px 0 8px">Student answers are <strong>auto-transcribed from speech</strong>. Anything the student then hand-edited is flagged <span class="pill warn">✎ student-edited</span> with the original speech-to-text and the change; everything else is the raw transcription.</p>
    <div class="reading-box">${transcript || "(empty)"}</div>
    <h3 style="margin-top:18px">AI feedback (for you to review)</h3>
    <textarea id="fb-text" rows="7">${esc(s.feedback || "")}</textarea>
    <div class="row" style="margin-top:10px">
      <button class="btn subtle" id="fb-gen">${s.feedback ? "Regenerate" : "Generate"} feedback</button>
      <button class="btn good" id="fb-approve">${s.feedbackApproved ? "Re-share with student" : "Approve & share with student"}</button>
      ${s.feedbackApproved ? `<span class="pill good">shared</span>` : ""}
    </div>
    <h3 style="margin-top:18px">Grade</h3>
    ${s.suggestedScore != null ? `<p class="meta">🤖 AI-suggested: <strong>${s.suggestedScore}/100</strong>${s.scoreRationale ? " — " + esc(s.scoreRationale) : ""} — you decide the final grade.</p>` : `<p class="meta">(No AI suggestion yet — needs an API key and a completed conversation.)</p>`}
    <div class="row" style="margin-top:6px">
      <input type="text" id="grade-input" style="max-width:180px" placeholder="e.g. 9/10, 85, or A-" value="${esc(s.grade != null ? s.grade : (s.suggestedScore != null ? String(s.suggestedScore) : ""))}"/>
      <button class="btn good" id="save-grade">Save grade</button>
      <span class="footnote" id="grade-status">${(s.grade != null && s.grade !== "") ? "saved ✓" : ""}</span>
    </div>`;
  d.style.display = "block";
  $("#del-sub").onclick = async () => { if (confirm("Delete this submission and its video permanently?")) { await api("/api/submissions/" + id, { method: "DELETE" }); $("#sub-detail").style.display = "none"; loadSubmissions(); } };
  $("#fb-gen").onclick = async () => {
    $("#fb-gen").disabled = true; $("#fb-gen").textContent = "Working…";
    const r = await api("/api/submissions/" + id + "/feedback", { method: "POST" });
    const dd = await r.json(); if (r.ok) $("#fb-text").value = dd.feedback; else toast(dd.error || "failed");
    $("#fb-gen").disabled = false; $("#fb-gen").textContent = "Regenerate feedback";
  };
  $("#fb-approve").onclick = async () => {
    await api("/api/submissions/" + id + "/approve", { json: true, method: "POST", body: JSON.stringify({ feedback: $("#fb-text").value }) });
    toast("Approved & shared"); loadSubmissions();
  };
  $("#save-grade").onclick = async () => {
    await api("/api/submissions/" + id + "/grade", { json: true, method: "POST", body: JSON.stringify({ grade: $("#grade-input").value }) });
    $("#grade-status").textContent = "saved ✓"; toast("Grade saved"); loadSubmissions();
  };
  // MediaRecorder .webm files often report duration:Infinity, which makes the browser unable to
  // seek (clicking a timestamp "freezes"). Force the browser to compute the real duration first.
  const vid = $("#sub-video");
  if (vid) {
    const fixDuration = () => {
      if (vid.duration === Infinity || isNaN(vid.duration)) {
        const wasMuted = vid.muted; vid.muted = true;
        const onUpd = () => { vid.removeEventListener("timeupdate", onUpd); try { vid.currentTime = 0; } catch {} vid.muted = wasMuted; };
        vid.addEventListener("timeupdate", onUpd);
        try { vid.currentTime = 1e101; } catch {}
      }
    };
    if (vid.readyState >= 1) fixDuration(); else vid.addEventListener("loadedmetadata", fixDuration, { once: true });
  }
  const seekVideo = off => {
    const v = $("#sub-video"); if (!v) return;
    const go = () => { try { v.currentTime = off; } catch {} v.play().catch(() => {}); };
    if (v.duration === Infinity || isNaN(v.duration)) {
      // duration not computed yet — wait for it, then seek (prevents the freeze)
      const onCanSeek = () => { v.removeEventListener("durationchange", onCanSeek); go(); };
      v.addEventListener("durationchange", onCanSeek); try { v.currentTime = 1e101; } catch {}
    } else go();
  };
  d.querySelectorAll(".vjump").forEach(a => a.onclick = ev => {
    ev.preventDefault();
    const v = $("#sub-video"); if (!v) return;
    seekVideo(parseFloat(a.dataset.off) || 0);
    if (v.scrollIntoView) v.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  // question-to-question navigation: jump the video AND scroll/highlight that exchange
  const chips = Array.from(d.querySelectorAll(".qchip[data-line]"));
  let curQ = -1;
  const gotoQ = idx => {
    if (idx < 0 || idx >= chips.length) return;
    curQ = idx;
    const a = chips[idx];
    chips.forEach(c => c.classList.toggle("active", c === a));
    if (a.dataset.off != null) seekVideo(parseFloat(a.dataset.off) || 0);
    const line = a.dataset.line && document.getElementById(a.dataset.line);
    if (line) {
      line.scrollIntoView({ behavior: "smooth", block: "center" });
      const prev = line.style.background;
      line.style.transition = "background .3s"; line.style.background = "var(--good-soft)";
      setTimeout(() => { line.style.background = prev; }, 1300);
    }
  };
  chips.forEach((a, idx) => a.onclick = ev => { ev.preventDefault(); gotoQ(idx); });
  const qprev = d.querySelector("#qprev"), qnext = d.querySelector("#qnext");
  if (qprev) qprev.onclick = ev => { ev.preventDefault(); gotoQ(curQ <= 0 ? 0 : curQ - 1); };
  if (qnext) qnext.onclick = ev => { ev.preventDefault(); gotoQ(curQ < 0 ? 0 : Math.min(chips.length - 1, curQ + 1)); };
  if (d.scrollIntoView) d.scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    d.style.display = "block";
    d.innerHTML = `<div class="banner err">Couldn't open this submission: ${esc(e.message)}.<br>Try a hard refresh (Ctrl+Shift+R). If it persists, tell Claude this exact message.</div>`;
    console.error("openSub failed:", e);
  }
}
