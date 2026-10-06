"use strict";
const $ = s => document.querySelector(s);
const toast = m => { const t = $("#toast"); t.textContent = m; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 2600); };
// A dismissible modal notice — used for the "you stepped away" / "you copied" conscience nudges.
// Non-blocking to recording; only one shows at a time so nudges don't stack.
function notice(html) {
  if (document.getElementById("notice-overlay")) return;
  const ov = document.createElement("div");
  ov.id = "notice-overlay";
  ov.style.cssText = "position:fixed;inset:0;background:rgba(20,18,15,.55);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px";
  ov.innerHTML = `<div style="background:#fff;max-width:460px;border-radius:14px;padding:22px 24px;box-shadow:0 12px 40px rgba(0,0,0,.3)">
    <div style="font-size:15px;line-height:1.55;color:#1c1b19">${html}</div>
    <div style="text-align:right;margin-top:18px"><button id="notice-ok" style="border:0;background:var(--accent,#6d3bd1);color:#fff;font-weight:650;padding:9px 18px;border-radius:9px;cursor:pointer;font-size:14px">I understand</button></div>
  </div>`;
  document.body.appendChild(ov);
  document.getElementById("notice-ok").onclick = () => ov.remove();
}
const esc = s => (s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const wordCount = s => (s.trim() ? s.trim().split(/\s+/).length : 0);

const params = new URLSearchParams(location.search);
const ASSIGNMENT_ID = params.get("a");

let assignment = null;
let history = [];          // [{role:'tutor'|'student', text}]
let student = { name: "", id: "" };
let studentWork = null; // COM 382: the student's own final definition + indicators (+ chatbot transcript)
let mediaStream = null, mediaRecorder = null, videoChunks = [];
let audioRecorder = null, audioChunks = []; // separate audio-only backup, in case the video recording fails
let qAudioRecorder = null; // per-question audio backup (uploaded live); each recorder buffers via a closure
let recordingStartedAt = null, sessionStartedAt = null;
// ---- AV reliability: detect/log capture gaps so the instructor knows if a recording is partial ----
const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
// Keep the recording small enough to upload reliably: 640x480 @ ~15fps is plenty to see the student.
const VIDEO_CONSTRAINTS = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 24 } };
let recordingGaps = [];          // [{startOffsetMs, endOffsetMs|null, reason}] — stretches where capture dropped
let recordingEverStarted = false;
let recordingStoppedEarly = false;
let finishing = false, restarting = false;
function closeOpenGaps(prefix) {
  for (const g of recordingGaps) if (g.endOffsetMs == null && (!prefix || g.reason.startsWith(prefix))) g.endOffsetMs = videoOffsetMs();
}
function watchTrack(track) {
  const kind = track.kind; // "video" | "audio"
  track.addEventListener("mute", () => {
    if (!sessionActive || finishing || recordingGaps.length >= 200) return;
    recordingGaps.push({ startOffsetMs: videoOffsetMs(), endOffsetMs: null, reason: kind + " muted" });
  });
  track.addEventListener("unmute", () => { closeOpenGaps(kind + " muted"); });
  track.addEventListener("ended", () => {
    if (!sessionActive || finishing) return;
    recordingStoppedEarly = true;
    closeOpenGaps(kind);
    if (recordingGaps.length < 200) recordingGaps.push({ startOffsetMs: videoOffsetMs(), endOffsetMs: null, reason: kind + " ended (device lost)" });
    tryRestartRecording();
  });
}
function startRecorders(stream) {
  const wantVideo = assignment && assignment.requireCamera !== false;
  try {
    const recOpts = pickMime();
    recOpts.videoBitsPerSecond = 500000; // ~0.5 Mbps — halves the file vs. before; fine for a talking-head
    recOpts.audioBitsPerSecond = 64000;
    mediaRecorder = new MediaRecorder(stream, recOpts);
    mediaRecorder.ondataavailable = e => { if (e.data && e.data.size) videoChunks.push(e.data); };
    mediaRecorder.onerror = () => { if (sessionActive && !finishing) { recordingStoppedEarly = true; tryRestartRecording(); } };
    mediaRecorder.start(1000);
    if (!recordingStartedAt) recordingStartedAt = Date.now();
    recordingEverStarted = true;
    setupInfo.recorderStarted = true;
    $("#recdot").style.display = "inline-block";
    $("#cam-status").textContent = wantVideo ? "Recording video" : "Recording audio";
  } catch (e) { $("#cam-status").textContent = "Recording unavailable"; }
  // separate audio-only backup — survives even if the video recording fails (common on Safari)
  try {
    const audioStream = new MediaStream(stream.getAudioTracks());
    const aMime = pickAudioMime();
    audioRecorder = new MediaRecorder(audioStream, aMime ? { mimeType: aMime, audioBitsPerSecond: 64000 } : {});
    audioRecorder.ondataavailable = e => { if (e.data && e.data.size) audioChunks.push(e.data); };
    if (!recordingStartedAt) recordingStartedAt = Date.now();
    audioRecorder.start(1000);
  } catch (e) { /* no audio backup available on this browser */ }
}
async function tryRestartRecording() {
  if (!sessionActive || finishing || restarting) return;
  restarting = true;
  try {
    const wantVideo = assignment && assignment.requireCamera !== false;
    const fresh = await navigator.mediaDevices.getUserMedia(wantVideo ? { video: VIDEO_CONSTRAINTS, audio: AUDIO_CONSTRAINTS } : { audio: AUDIO_CONSTRAINTS });
    try { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); } catch {}
    mediaStream = fresh;
    const cam = $("#cam"); if (cam) cam.srcObject = fresh;
    fresh.getTracks().forEach(watchTrack);
    startRecorders(fresh); // new segment appended to the same chunk arrays
    closeOpenGaps(); // capture resumed
  } catch (e) { /* couldn't reacquire — the open gap stays open → marked partial */ }
  restarting = false;
}
let sessionSeed = Math.floor(Math.random() * 1e9) + 1; // randomizes question order/angle per student
let sessionId = null; // unique id for this attempt, used to autosave progress server-side
let heartbeatTimer = null; // pings the server periodically so the instructor can see live sessions
function saveProgress() {
  if (!sessionId) return;
  fetch("/api/progress", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, assignmentId: ASSIGNMENT_ID, student, history, startedAt: sessionStartedAt, awayEvents, copyEvents, pasteEvents, setupInfo, studentWork })
  }).catch(() => {}); // fire-and-forget; never block the conversation on this
}
let sessionActive = false; // true while a conversation is in progress and not yet submitted

// ---- integrity signals (not proof — just "worth a look", paired with the video) ----
let awayEvents = [];   // each time the student left the page: {videoOffsetMs, durationMs, q}
let copyEvents = [];   // each copy: {text, videoOffsetMs, q}
let pasteEvents = [];  // each paste into the answer box: {text, videoOffsetMs, q}
let awayStart = null;
// Starting the mic can make Chrome briefly take focus (permission bubble, mic indicator).
// Ignore short focus losses that begin right after recording starts.
let micGraceUntil = 0, awayWasHidden = false;
const MIC_GRACE_MS = 4000, MIC_GRACE_MAX_AWAY_MS = 10000;
const questionNum = () => history.filter(h => h.role === "tutor").length;
// "away" = the tab is hidden OR the window lost focus (e.g. alt-tabbed to another app/window).
// Only record stretches longer than 1.5s, so momentary focus blips (clicking the address bar) don't count.
function checkActivity() {
  const active = !document.hidden && document.hasFocus();
  if (!active && document.hidden) awayWasHidden = true; // a real tab switch / minimize, never a mic blip
  if (!active && awayStart === null) {
    awayStart = Date.now();
  } else if (active && awayStart !== null) {
    const dur = Date.now() - awayStart;
    const micBlip = awayStart <= micGraceUntil && dur < MIC_GRACE_MAX_AWAY_MS && !awayWasHidden;
    awayWasHidden = false;
    if (micBlip) { awayStart = null; return; }
    if (sessionActive && dur > 1500 && awayEvents.length < 100) {
      awayEvents.push({ at: awayStart, videoOffsetMs: awayStart - (recordingStartedAt || awayStart), durationMs: dur, q: questionNum() });
      // >3s away = a real switch to another window/app (not an address-bar blip) — nudge them, on return.
      if (dur > 3000) notice("<strong>I noticed you left the assessment.</strong><br><br>This is a live, recorded spoken assessment — please stay on this page and answer from what you already know. <strong>The times you leave are recorded and shown to your instructor.</strong>");
    }
    awayStart = null;
  }
}
document.addEventListener("visibilitychange", checkActivity);
window.addEventListener("blur", checkActivity);
window.addEventListener("focus", checkActivity);
document.addEventListener("copy", () => {
  if (!sessionActive) return;
  const sel = (document.getSelection && document.getSelection().toString()) || "";
  if (copyEvents.length < 100) copyEvents.push({ at: Date.now(), text: sel.slice(0, 1000), videoOffsetMs: videoOffsetMs(), q: questionNum() });
  // Conscience nudge, not a block — copying still works (so magnifiers/translators aren't broken),
  // but the student is asked to justify it. Screen readers don't fire 'copy', so this never hits them.
  notice("<strong>It looks like you copied text from this page.</strong><br><br>Is there a genuine accessibility or academic reason? If so, that's fine — but please make sure you've <strong>registered with Disability Services and/or spoken with your instructor</strong> about your needs.<br><br>If not, please don't — this is a spoken assessment, and copying is recorded and shown to your instructor.");
});

// Warn before closing the tab mid-conversation (browsers show a generic confirm dialog).
window.addEventListener("beforeunload", (e) => {
  if (sessionActive) { e.preventDefault(); e.returnValue = ""; }
});
const videoOffsetMs = () => (recordingStartedAt ? Date.now() - recordingStartedAt : null);
let recog = null, listening = false, waitTimer = null;
let recognizedText = ""; // the raw speech-to-text for the CURRENT answer (the "original")
let answerFirstWordAt = null, answerFirstWordOffsetMs = null; // when the student first started speaking this answer
let answerLastWordAt = null, answerLastWordOffsetMs = null; // most recent speech this answer (≈ when they stopped talking)
let answerReadyAt = null; // when the mic actually opened for this answer (i.e. the coach FINISHED speaking the question)
let busy = false;
let pasteUsed = false; // flags if the student pasted into the answer box (integrity signal)
let timeOverFlag = false; // flags if the student went past the per-answer time limit on any answer
let manuallyEdited = false; // true only when the student actually types/edits (not the speech engine)
// ---- setup diagnostics: so the instructor can SEE why a struggling student's session failed ----
let setupInfo = {
  userAgent: navigator.userAgent,
  speechApiAvailable: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
  micPermission: "unknown",   // granted | denied | prompt | unknown (from the Permissions API)
  gotAudioTrack: false,       // getUserMedia actually returned a microphone track
  gotVideoTrack: false,
  speechStarted: false,       // speech recognition successfully began at least once
  speechError: null,          // last speech-recognition error (e.g. "not-allowed", "network")
  recorderStarted: false      // MediaRecorder actually started
};

// ---------- load assignment ----------
(async function init() {
  if (!ASSIGNMENT_ID) { $("#msg").innerHTML = `<div class="banner err">This link is missing an assignment. Ask your instructor for the correct link.</div>`; return; }
  try {
    const r = await fetch("/api/assignments/" + ASSIGNMENT_ID + "/run");
    if (!r.ok) throw 0;
    assignment = await r.json();
  } catch { $("#msg").innerHTML = `<div class="banner err">Couldn't load this assignment. The link may be wrong, or the app isn't running.</div>`; return; }

  $("#intro").style.display = "block";
  $("#head-title").textContent = assignment.title;
  $("#intro-title").textContent = assignment.title;
  $("#intro-sub").textContent = `${assignment.subject || ""} · You'll have a short spoken conversation about this module's material.`;
  if (assignment.readingText) {
    $("#reading").textContent = assignment.readingText;
  } else {
    $("#reading-wrap").style.display = "none"; // source doc is private to the AI
  }
  if (assignment.requireCamera) $("#cam-note").style.display = "block";
  if (assignment.requireStudentWork) $("#work-box").style.display = "block";

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const sn = $("#speech-note");
  if (SR) {
    sn.className = "footnote";
    sn.textContent = "Tip: speak naturally — your spoken words turn into text automatically. (Use Chrome or Edge.)";
  } else {
    // Hard stop: this browser can't do voice. Don't let them start, and don't invite typing.
    sn.className = "banner err";
    sn.innerHTML = "🚫 <strong>This browser won't work for this assignment.</strong> It can't record spoken answers.<br><br>Please open this same link in <strong>Google Chrome</strong> or <strong>Microsoft Edge</strong> on a computer, and begin there. <span class='footnote'>(Chrome or Edge on a computer is the most reliable. Firefox isn't supported.)</span>";
    $("#begin-btn").disabled = true;
    $("#begin-btn").textContent = "Open in Chrome or Edge to begin";
  }
})();


// Show the student their own pasted work during the conversation, so they don't need to leave the page.
function showMyWork() {
  if (!studentWork) return;
  const box = $("#mywork"); if (!box) return;
  box.innerHTML = "";
  const parts = [["Concept", studentWork.concept], ["Conceptual definition", studentWork.definition], ["Indicators", studentWork.indicators], ["Validity and reliability", studentWork.validity]];
  for (const [label, text] of parts) {
    if (!text) continue;
    const h = document.createElement("h4"); h.style.margin = "10px 0 4px"; h.textContent = label;
    const d = document.createElement("div"); d.className = "reading-box"; d.style.whiteSpace = "pre-wrap"; d.textContent = text;
    box.appendChild(h); box.appendChild(d);
  }
  $("#mywork-card").style.display = "block";
}

// ---------- begin ----------
$("#begin-btn").addEventListener("click", async () => {
  if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) return toast("Please open this link in Chrome or Edge on a computer.");
  student.name = $("#s-name").value.trim();
  student.email = $("#s-email").value.trim();
  student.id = $("#s-id").value.trim();
  if (!student.name) return toast("Please enter your name");
  if (!/@([a-z0-9-]+\.)*(uw|washington)\.edu$/i.test(student.email)) return toast("Please enter your UW email (e.g. netid@uw.edu)");
  if (!student.id) return toast("Please enter your student ID number");

  if (assignment.requireStudentWork) {
    studentWork = {
      concept: $("#w-concept").value.trim(),
      definition: $("#w-definition").value.trim(),
      indicators: $("#w-indicators").value.trim(),
      validity: $("#w-validity").value.trim(),
      transcript: $("#w-transcript").value.trim()
    };
    if (!studentWork.concept) return toast("Please enter your concept.");
    if (studentWork.definition.split(/\s+/).length < 15) return toast("Please paste your full conceptual definition, including your dimensions.");
    if (studentWork.indicators.split(/\s+/).length < 10) return toast("Please paste your full set of indicators.");
  }

  if (!$("#agree-rules") || !$("#agree-rules").checked) return toast("Please read the ground rules and check the box to begin.");
  showMyWork();

  // AV is the highest-value signal for resolving an ambiguous session, so it's required by default.
  // The instructor can mark an assignment "AV optional" (accommodation), which relaxes the hard block.
  const wantVideo = assignment.requireCamera !== false; // record video unless the instructor turned camera off
  const avRequired = !assignment.avOptional;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia(
      wantVideo ? { video: VIDEO_CONSTRAINTS, audio: AUDIO_CONSTRAINTS } : { audio: AUDIO_CONSTRAINTS }
    );
  } catch {
    if (avRequired) return toast(wantVideo
      ? "This assignment is recorded. Please ALLOW camera and microphone when your browser asks, then click Begin again."
      : "This assignment is recorded. Please ALLOW microphone access when your browser asks, then click Begin again.");
    mediaStream = null; // accommodation: proceed with no recording
  }
  if (avRequired) {
    if (!mediaStream || !mediaStream.getAudioTracks().length) {
      return toast("No microphone was detected. Please connect or enable a mic, then click Begin again.");
    }
    if (wantVideo && !mediaStream.getVideoTracks().length) {
      return toast("No camera was detected. Please enable your camera, then click Begin again.");
    }
    if (!window.MediaRecorder) {
      return toast("This browser can't record. Please use Chrome or Edge on a computer.");
    }
  }

  // record what the student's setup actually did (so failures are diagnosable, not guesswork)
  setupInfo.gotAudioTrack = !!(mediaStream && mediaStream.getAudioTracks().length);
  setupInfo.gotVideoTrack = !!(mediaStream && mediaStream.getVideoTracks().length);
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const p = await navigator.permissions.query({ name: "microphone" });
      setupInfo.micPermission = p.state; // granted | denied | prompt
    }
  } catch { /* Permissions API not available for mic on this browser */ }

  if (mediaStream) $("#cam").srcObject = mediaStream;
  $("#intro").style.display = "none";
  $("#session").style.display = "block";
  sessionStartedAt = Date.now();
  sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  sessionActive = true;
  saveProgress(); // register this attempt immediately so it shows as "active now"
  heartbeatTimer = setInterval(saveProgress, 30000); // keep the "active now" status fresh

  // record the whole session, watching for mid-session drops
  if (mediaStream && window.MediaRecorder) {
    mediaStream.getTracks().forEach(watchTrack);
    startRecorders(mediaStream);
    // pre-flight: confirm the camera is actually producing frames a few seconds in
    if (wantVideo) setTimeout(() => {
      const cam = $("#cam");
      if (sessionActive && !finishing && cam && !cam.videoWidth) {
        if (recordingGaps.length < 200) recordingGaps.push({ startOffsetMs: 0, endOffsetMs: null, reason: "no camera frames at start" });
        $("#cam-status").textContent = "⚠ Camera may not be capturing — check nothing else is using it";
      }
    }, 3500);
  } else {
    $("#cam-status").textContent = "No recording (accommodation)";
  }

  coachTurn(); // AI opens
});

// ---------- per-question audio: record each answer, then transcribe it on the SERVER ----------
// Recording the answer locally (not the browser's live speech engine) is what makes transcription
// immune to the student's mic routing / connection / browser. The clip is also the durable backup.
function startQuestionAudio() {
  if (!mediaStream || !window.MediaRecorder) return;
  try {
    const tracks = mediaStream.getAudioTracks();
    if (!tracks.length) return;
    const chunks = [];                 // THIS recorder's own buffer (closure — no shared-state race)
    const aMime = pickAudioMime();
    const rec = new MediaRecorder(new MediaStream(tracks), aMime ? { mimeType: aMime, audioBitsPerSecond: 64000 } : {});
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec._blob = () => chunks.length ? new Blob(chunks, { type: chunks[0].type || "audio/webm" }) : null;
    rec.start();
    qAudioRecorder = rec;
  } catch (e) { qAudioRecorder = null; }
}
// Stop the current answer's recorder and resolve with its audio blob.
function stopQuestionAudioBlob() {
  return new Promise(resolve => {
    const rec = qAudioRecorder; qAudioRecorder = null;
    if (!rec) return resolve(null);
    const grab = () => resolve(rec._blob ? rec._blob() : null);
    if (rec.state === "inactive") return grab();
    rec.onstop = grab;
    try { rec.stop(); } catch { grab(); }
  });
}
// Upload one answer's audio: server stores it (backup) AND returns an accurate transcript (Whisper).
// Returns "" if the server has no Whisper key or it fails — caller then falls back to browser text.
async function transcribeAnswer(blob, q) {
  if (!blob || !blob.size) return "";
  const fd = new FormData();
  fd.append("sessionId", sessionId || "");
  fd.append("assignmentId", ASSIGNMENT_ID);
  fd.append("studentName", student.name || "");
  fd.append("q", String(q));
  fd.append("audio", blob, "q" + q + "-audio.webm");
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { const r = await fetch("/api/transcribe", { method: "POST", body: fd }); const d = await r.json(); return (d && d.text) || ""; }
    catch { await new Promise(res => setTimeout(res, 800)); }
  }
  return "";
}

function pickAudioMime() {
  const opts = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
  for (const m of opts) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return "";
}

function pickMime() {
  const opts = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "audio/webm"];
  for (const m of opts) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return { mimeType: m };
  return {};
}

// ---------- conversation loop ----------
function addBubble(role, text) {
  const b = document.createElement("div");
  b.className = "bubble " + role;
  b.textContent = text;
  $("#chat").appendChild(b);
  b.scrollIntoView({ behavior: "smooth", block: "end" });
}

function showRetry(msg) {
  $("#mic-status").textContent = msg;
  $("#retry-btn").style.display = "inline-block";
  setMic(false, "…");
}
$("#retry-btn").addEventListener("click", () => { $("#retry-btn").style.display = "none"; coachTurn(); });

async function coachTurn() {
  if (busy) return; busy = true;
  $("#retry-btn").style.display = "none";
  setMic(false, "Coach is speaking…");
  $("#mic-status").textContent = "…";
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 75000); // don't let a hung server strand the student
    const r = await fetch("/api/conversation", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignmentId: ASSIGNMENT_ID, student, history, seed: sessionSeed, sessionId, studentWork }),
      signal: ctrl.signal
    });
    clearTimeout(to);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { busy = false; showRetry((d && d.error ? d.error : "The coach had trouble responding.") + " Click Retry."); return; }

    history.push({ role: "tutor", text: d.say, at: Date.now(), videoOffsetMs: videoOffsetMs() });
    const tutorEntry = history[history.length - 1];
    addBubble("tutor", d.say);
    saveProgress();
    speak(d.say, () => {
      // coach finished reading this turn aloud — the true "clock starts" for the student's pause
      tutorEntry.spokenEndAt = Date.now();
      tutorEntry.spokenEndOffsetMs = videoOffsetMs();
      saveProgress();
      if (d.done) { finish(); }
      else { enableAnswering(); }
      busy = false;
    }, () => {
      // coach's voice actually began for this turn
      tutorEntry.spokenStartAt = Date.now();
      tutorEntry.spokenStartOffsetMs = videoOffsetMs();
    });
  } catch (e) { busy = false; showRetry((e && e.name === "AbortError") ? "That took too long to respond. Click Retry — your conversation is safe." : "Connection problem. Click Retry — your conversation is safe."); }
}

function updateProgressCue() {
  const el = $("#progress-cue"); if (!el) return;
  el.style.display = "block";
  el.innerHTML = `📌 <strong>Question ${questionNum()}</strong> — keep going until you see the green <strong>“✓ All done”</strong> screen. Your session is only saved when you finish, so <strong>don't close or leave this tab</strong> until you see it.`;
}
function enableAnswering() {
  recognizedText = ""; manuallyEdited = false; answerFirstWordAt = null; answerFirstWordOffsetMs = null; answerLastWordAt = null; answerLastWordOffsetMs = null; answerReadyAt = null; $("#answer").value = ""; updateWC();
  updateProgressCue();
  startQuestionAudio(); // per-question audio backup — small, uploads live, survives even if the full recording fails
  $("#edit-note").style.color = "var(--muted)";
  $("#edit-note").innerHTML = STATIC_EDIT_NOTE;
  // show the question being answered right above the answer box, so both are on screen
  const lastTutor = [...history].reverse().find(h => h.role === "tutor");
  if (lastTutor) $("#current-q").textContent = lastTutor.text;
  const wait = assignment.waitingTime || 0;
  if (wait > 0) {
    let left = wait;
    const cd = $("#countdown"); cd.style.display = "block";
    cd.textContent = `You're being recorded. Take a moment to gather your thoughts — you'll start speaking in ${left}s (or click the mic to start now).`;
    setMic(true, "Start now");
    $("#mic-status").textContent = "Get ready — you'll be prompted to speak in a moment.";
    waitTimer = setInterval(() => {
      left--;
      if (left <= 0) { clearInterval(waitTimer); waitTimer = null; cd.style.display = "none"; if (!listening) startListening(); startAnswerLimit(); startAnswerWindow(); }
      else cd.textContent = `You're being recorded. Take a moment to gather your thoughts — you'll start speaking in ${left}s (or click the mic to start now).`;
    }, 1000);
  } else {
    setMic(true, "…");
    $("#mic-status").textContent = "The mic is now open — just start speaking. Click Stop when you're done.";
    setTimeout(() => { if (!listening) startListening(); }, 500); // auto-start after the coach finishes
    startAnswerLimit(); // the per-answer countdown begins now
    startAnswerWindow(); // and the "must start speaking" window
  }
}

function setMic(enabled, label) {
  const m = $("#mic"); m.disabled = !enabled; $("#mic-label").textContent = label;
  $("#send-btn").disabled = !enabled;
}

// ---------- speech recognition ----------
$("#mic").addEventListener("click", () => listening ? stopListening() : startListening());
const STATIC_EDIT_NOTE = "🎙 The text above is a <strong>live preview</strong> — your final answer is transcribed from your <strong>audio</strong> when you click Send, so don't worry if the preview looks rough.";
$("#answer").addEventListener("input", () => {
  updateWC();
  // The 'input' event fires ONLY on real user typing/paste/delete — the speech engine
  // sets .value programmatically, which does NOT fire it. So this is a true manual-edit signal.
  manuallyEdited = true;
  const cur = $("#answer").value.trim();
  const spoken = recognizedText.replace(/\s+/g, " ").trim();
  if (spoken && cur !== spoken) {
    $("#edit-note").innerHTML = "✎ <strong>You've edited the transcript.</strong> Your original spoken words and this change are saved and shown to your instructor.";
    $("#edit-note").style.color = "var(--warn)";
  } else {
    $("#edit-note").innerHTML = STATIC_EDIT_NOTE;
    $("#edit-note").style.color = "var(--muted)";
  }
});
$("#answer").addEventListener("paste", (e) => {
  e.preventDefault(); // pasting is disabled — this is a spoken answer. Still logged for the instructor.
  pasteUsed = true;
  const t = (e.clipboardData && e.clipboardData.getData("text")) || "";
  if (pasteEvents.length < 100) pasteEvents.push({ at: Date.now(), text: t.slice(0, 1000), videoOffsetMs: videoOffsetMs(), q: questionNum() });
  $("#mic-status").textContent = "⚠ Pasting is disabled — please speak your answer.";
  toast("Pasting isn't allowed here — please speak your answer.");
});
$("#answer").addEventListener("drop", (e) => { e.preventDefault(); toast("Dropping text isn't allowed — please speak your answer."); });
function updateWC() {
  const n = wordCount($("#answer").value);
  const min = assignment.minWords || 0;
  $("#wc").textContent = n + " words" + (min ? ` (need ${min}+)` : "");
  $("#wc").style.color = (min && n < min) ? "var(--warn)" : "var(--muted)";
}

function startListening(attempt) {
  micGraceUntil = Date.now() + MIC_GRACE_MS;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
  $("#countdown").style.display = "none";
  if (!SR) { setMic(false, "Not supported"); $("#send-btn").disabled = true; $("#mic-status").textContent = "This browser can't record voice. Please reopen this link in Chrome or Edge."; return; }
  // Don't open the mic while the coach is still talking (prevents capturing its voice)
  if (window.speechSynthesis && window.speechSynthesis.speaking) {
    setTimeout(() => { if (!listening) startListening(attempt); }, 300);
    return;
  }
  if (recog) { try { recog.abort(); } catch {} recog = null; }
  recog = new SR();
  recog.continuous = true; recog.interimResults = true; recog.lang = "en-US";
  recog.onstart = () => {
    listening = true;
    if (answerReadyAt == null) answerReadyAt = Date.now(); // mic is live — the true "clock starts" for the pause
    setupInfo.speechStarted = true;
    $("#retry-btn").style.display = "none";
    $("#mic").classList.add("live"); $("#mic-label").textContent = "Stop";
    $("#mic-status").textContent = "🎙 Listening… speak your answer, then click Stop.";
  };
  recog.onresult = ev => {
    if (answerFirstWordAt == null) { answerFirstWordAt = Date.now(); answerFirstWordOffsetMs = videoOffsetMs(); }
    answerLastWordAt = Date.now(); answerLastWordOffsetMs = videoOffsetMs(); // keep bumping — the last one is when they stopped
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const t = ev.results[i][0].transcript;
      if (ev.results[i].isFinal) recognizedText += t + " "; else interim += t;
    }
    $("#answer").value = (recognizedText + interim).replace(/\s+/g, " ").trimStart();
    updateWC();
  };
  recog.onerror = e => {
    if (e.error && e.error !== "no-speech" && e.error !== "aborted") setupInfo.speechError = e.error;
    if (e.error === "not-allowed" || e.error === "service-not-allowed") { $("#mic-status").textContent = "Microphone blocked — please allow microphone access and click the mic to try again. If it still won't work, stop and contact your instructor."; }
    else if (e.error !== "no-speech" && e.error !== "aborted") { $("#mic-status").textContent = "Mic hiccup (" + e.error + "). Click the mic to try again. If it keeps happening, contact your instructor."; }
  };
  recog.onend = () => { if (listening) { try { recog.start(); } catch {} } }; // keep alive across the API's auto-stops
  try {
    recog.start();
  } catch (err) {
    // start() can throw if a previous instance hasn't released yet — retry once
    if (!attempt) { setTimeout(() => startListening(1), 600); }
    else { setMic(true, "Start answering"); $("#mic-status").textContent = "Tap the mic when you're ready to talk."; }
  }
}
function stopListening() {
  listening = false;
  if (recog) { try { recog.stop(); } catch {} recog = null; }
  $("#mic").classList.remove("live"); $("#mic-label").textContent = "Start answering";
  $("#mic-status").textContent = "Review your answer, then Send (or keep talking).";
}

// ---------- send answer (manual, or forced when the time limit runs out) ----------
$("#send-btn").addEventListener("click", () => submitAnswer(false));
let submitting = false;
async function submitAnswer(forced, emptyMsg) {
  if (submitting || busy) return;
  submitting = true;
  clearAnswerLimit();
  clearAnswerWindow();
  const q = questionNum();
  const browserText = $("#answer").value.trim();
  const spoken = recognizedText.replace(/\s+/g, " ").trim();

  // Finalize this answer's audio, then transcribe it SERVER-SIDE (accurate, connection-proof).
  const blob = await stopQuestionAudioBlob();
  let ans = "", source = "browser";
  if (blob && blob.size) {
    setMic(false, "…");
    $("#mic-status").textContent = "📝 Transcribing your answer…";
    const w = await transcribeAnswer(blob, q);
    if (w && w.trim()) { ans = w.trim(); source = "server"; }
  }
  if (!ans) ans = browserText; // fall back to the browser transcription (+ any edits) if Whisper is off/failed

  if (!forced && !ans) {
    // nothing captured — let them try again on this same question
    submitting = false;
    $("#mic-status").textContent = "We didn't catch that — please speak your answer, then click Send.";
    startQuestionAudio(); if (!listening) startListening(); setMic(true, "…");
    return;
  }
  if (forced && !ans) ans = emptyMsg || "(no answer given before the time limit)";

  stopListening();
  // manual-edit flag only applies to the browser-text path (Whisper transcribes the audio directly)
  const edited = source === "browser" && manuallyEdited && spoken.length > 0 && spoken !== ans;
  history.push({ role: "student", text: ans, spoken: source === "server" ? (browserText || null) : spoken, edited, transcriptSource: source, at: Date.now(), videoOffsetMs: videoOffsetMs(), firstWordAt: answerFirstWordAt, firstWordOffsetMs: answerFirstWordOffsetMs, lastWordAt: answerLastWordAt, lastWordOffsetMs: answerLastWordOffsetMs, readyAt: answerReadyAt });
  addBubble("student", ans);
  saveProgress();
  $("#answer").value = ""; updateWC();
  setMic(false, "…");
  submitting = false;
  if (forced) toast("Time's up — sending your answer.");
  coachTurn();
}

// ---------- answer window: must START speaking within N seconds (no sitting silently) ----------
let answerWindowTimer = null;
function clearAnswerWindow() { if (answerWindowTimer) { clearTimeout(answerWindowTimer); answerWindowTimer = null; } }
function startAnswerWindow() {
  clearAnswerWindow();
  const w = assignment.answerWindow || 0; // seconds; 0 = off
  if (!w) return;
  answerWindowTimer = setTimeout(() => {
    if (answerFirstWordAt == null) { // they never began speaking — move the session along
      toast("No answer detected — moving on.");
      submitAnswer(true, "(no answer — the student did not begin speaking within the time allowed)");
    }
  }, w * 1000);
}

// ---------- per-answer time limit ----------
let answerLimitTimer = null;
function clearAnswerLimit() {
  if (answerLimitTimer) { clearInterval(answerLimitTimer); answerLimitTimer = null; }
  const el = $("#answer-timer"); if (el) el.textContent = "";
}
const GRACE_SECONDS = 75; // soft cap: after the limit, this much extra before an auto-send backstop
function startAnswerLimit() {
  clearAnswerLimit();
  const limit = assignment.answerLimit || 0; // seconds; 0 = no limit
  const el = $("#answer-timer");
  if (!limit || !el) return;
  // Subtle by design: a gentle note up front, the live countdown only near the end, and at the
  // limit a soft "wrap up" nudge (never a mid-sentence cutoff). A grace backstop ends a stalled
  // session so it can't run forever. Going over is a FLAG for the instructor, not an auto-penalty.
  const warnAt = Math.min(120, Math.max(15, Math.round(limit * 0.3)));
  const human = limit >= 60
    ? (limit % 60 === 0 ? (limit / 60) + ((limit / 60) === 1 ? " minute" : " minutes") : (limit / 60).toFixed(1).replace(/\.0$/, "") + " minutes")
    : limit + " seconds";
  el.style.color = "var(--muted)"; el.style.fontWeight = "400";
  el.textContent = "You have up to " + human + " for this answer — take your time.";
  let left = limit, over = 0;
  answerLimitTimer = setInterval(() => {
    if (left > 0) {
      left--;
      if (left <= warnAt) { // only now show the ticking clock — calm, not alarming
        const m = Math.floor(left / 60), s = left % 60;
        el.textContent = "⏱ " + m + ":" + String(s).padStart(2, "0") + " left";
        el.style.fontWeight = "600";
        el.style.color = left <= 15 ? "var(--warn)" : "var(--muted)";
      }
      return;
    }
    // Past the suggested time: gentle nudge, no cutoff. Flag it once.
    if (over === 0) { timeOverFlag = true; }
    over++;
    el.style.fontWeight = "600"; el.style.color = "var(--danger)";
    el.textContent = "⏱ Time to wrap up — please finish your thought and click Send.";
    if (over >= GRACE_SECONDS) { clearAnswerLimit(); submitAnswer(true); } // backstop for a stalled session
  }, 1000);
}

// ---------- text-to-speech ----------
function speak(text, done, onStart) {
  let fired = false, poll = null, started = false;
  const markStart = () => { if (started) return; started = true; if (onStart) onStart(); }; // coach's voice actually began
  const fire = () => { if (fired) return; fired = true; if (poll) clearInterval(poll); if (done) done(); };
  if (!window.speechSynthesis) { markStart(); return fire(); }
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02; u.onstart = markStart; u.onend = fire; u.onerror = fire;
    window.speechSynthesis.speak(u);
    // Safety net that RESPECTS actual playback: never advance while speech is still
    // playing. Wait for it to start, then fire only once it has truly stopped.
    let waited = 0;
    poll = setInterval(() => {
      waited += 250;
      const speaking = window.speechSynthesis.speaking;
      if (speaking) markStart(); // some browsers don't fire onstart — catch real playback here
      if ((waited > 900 && !speaking) || waited > 120000) fire();
    }, 250);
  } catch { markStart(); fire(); }
}

// ---------- finish & upload ----------
async function finish() {
  finishing = true;
  setMic(false, "Done");
  $("#session").style.display = "none";
  $("#done").style.display = "block";
  $("#uploading-box").style.display = "block";
  $("#done-box").style.display = "none";
  $("#upload-status").textContent = "Finishing up…";

  closeOpenGaps(); // any capture drop still open ran to the end of the session
  // stop recording and gather both the video and the audio-backup blobs
  const { video, audio } = await stopRecording();
  const hadVideo = !!(video && video.size), hadAudio = !!(audio && audio.size);

  const fd = new FormData();
  fd.append("assignmentId", ASSIGNMENT_ID);
  fd.append("studentName", student.name);
  fd.append("studentEmail", student.email || "");
  fd.append("studentId", student.id);
  fd.append("history", JSON.stringify(history));
  fd.append("startedAt", String(sessionStartedAt || ""));
  fd.append("endedAt", String(Date.now()));
  fd.append("sessionId", sessionId || "");
  fd.append("flaggedPaste", pasteUsed ? "1" : "");
  fd.append("flaggedTimeOver", timeOverFlag ? "1" : "");
  fd.append("awayEvents", JSON.stringify(awayEvents));
  fd.append("copyEvents", JSON.stringify(copyEvents));
  fd.append("pasteEvents", JSON.stringify(pasteEvents));
  fd.append("recordingGaps", JSON.stringify(recordingGaps));
  fd.append("recordingEverStarted", recordingEverStarted ? "1" : "");
  fd.append("recordingStoppedEarly", recordingStoppedEarly ? "1" : "");
  fd.append("setupInfo", JSON.stringify(setupInfo));
  fd.append("studentWork", JSON.stringify(studentWork));
  if (hadVideo) fd.append("video", video, "session.webm");
  if (hadAudio) fd.append("audio", audio, "session-audio.webm");

  // upload with a live progress bar + verification + retry; keep the tab "busy" until it confirms
  let ok = false, lastErr = "", lastD = null;
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    try {
      const d = await uploadWithProgress("/api/submit", fd, frac => {
        const pct = Math.round(frac * 100);
        const bar = $("#upload-bar"); if (bar) bar.style.width = pct + "%";
        $("#upload-status").textContent = `Uploading your recording… ${pct}%${attempt > 1 ? ` (retry ${attempt})` : ""}`;
      });
      // verify what we sent actually stored
      if ((hadVideo && !(d.videoBytes > 0)) && (hadAudio && !(d.audioBytes > 0))) throw new Error("recording didn't store");
      ok = true; lastD = d;
    } catch (e) { lastErr = e.message; if (attempt < 3) { $("#upload-status").textContent = "Connection hiccup — retrying…"; await new Promise(res => setTimeout(res, attempt * 1500)); } }
  }
  sessionActive = false; // upload finished (or gave up) — safe to leave now, so beforeunload stops warning
  $("#uploading-box").style.display = "none";
  if (ok) {
    const avNote = lastD && lastD.avStatus === "partial" ? " (your video didn't fully save, but your audio did — your instructor has your answers)" : "";
    $("#done-box").style.display = "block";
    $("#done-box").innerHTML = `✓ <strong>All done — submitted successfully.</strong> You can safely close this tab now. Thank you!${avNote}`;
    if (lastD && lastD.feedbackShared && lastD.feedback) {
      $("#done-feedback").innerHTML = `<h3>Feedback from your instructor's AI coach</h3><div class="reading-box">${esc(lastD.feedback)}</div>`;
    }
  } else {
    $("#done-box").style.display = "block";
    $("#done-box").className = "banner warn";
    $("#done-box").innerHTML = `Your answers were saved, but the recording upload had a problem (${esc(lastErr)}). Your instructor still has your transcript and per-question audio — please let them know.`;
  }

  if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  clearAnswerLimit();
  clearAnswerWindow();
  if (qAudioRecorder && qAudioRecorder.state !== "inactive") { try { qAudioRecorder.stop(); } catch {} qAudioRecorder = null; }
}
// POST a FormData with an upload progress callback (fetch can't report upload progress; XHR can)
function uploadWithProgress(url, fd, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.timeout = 300000; // 5 min per attempt — a big video on slow wifi needs room
    xhr.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let d = {}; try { d = JSON.parse(xhr.responseText || "{}"); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(d);
      else reject(new Error(d.error || ("server error " + xhr.status)));
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.ontimeout = () => reject(new Error("upload timed out"));
    xhr.send(fd);
  });
}
function stopRecording() {
  const stopOne = (rec, chunks, fallbackType) => new Promise(resolve => {
    const make = () => chunks.length ? new Blob(chunks, { type: chunks[0]?.type || fallbackType }) : null;
    if (!rec || rec.state === "inactive") return resolve(make());
    rec.onstop = () => resolve(make());
    try { rec.stop(); } catch { resolve(make()); }
  });
  return Promise.all([
    stopOne(mediaRecorder, videoChunks, "video/webm"),
    stopOne(audioRecorder, audioChunks, "audio/webm")
  ]).then(([video, audio]) => ({ video, audio }));
}
