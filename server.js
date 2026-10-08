require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const archiver = require("archiver");
const store = require("./lib/store");
const pdf = require("./lib/pdf");
const claude = require("./lib/claude");
const whisper = require("./lib/whisper");

// Normalize typographic glyphs in a source document to ASCII-safe equivalents (per #10),
// so smart quotes / em-dashes / bullets / zero-width chars can't corrupt the coach's source text.
function normalizeSourceDoc(text) {
  if (!text) return text;
  return text
    .replace(/[“”„‟″‶]/g, '"')         // smart double quotes
    .replace(/[‘’‚‛′‵]/g, "'")         // smart single quotes / apostrophes
    .replace(/—/g, "--")                                        // em dash
    .replace(/[–‒‐‑]/g, "-")                     // en/figure dash, non-breaking hyphen
    .replace(/…/g, "...")                                       // ellipsis
    .replace(/[•●▪◦‣⁃·∙]/g, "-") // bullets / middots
    .replace(/[   ]/g, " ")                           // non-breaking / figure spaces
    .replace(/[​‌‍﻿­]/g, "");               // zero-width / soft hyphen
}
// Heuristic: which configured concepts don't appear to be covered by the source doc (per #10).
function missingConcepts(concepts, doc) {
  if (!concepts || !concepts.length) return [];
  if (!doc || !doc.trim()) return concepts.slice();
  const low = doc.toLowerCase();
  const stop = new Set(["the", "and", "of", "a", "to", "in", "is", "on", "for", "with", "that", "this", "it", "as", "or", "an", "by", "be", "are", "you", "your"]);
  const missing = [];
  for (const c of concepts) {
    const cl = c.toLowerCase();
    if (low.includes(cl)) continue; // exact phrase present
    const words = cl.split(/[^a-z0-9]+/).filter(w => w.length > 3 && !stop.has(w));
    if (!words.length) { missing.push(c); continue; }
    const hits = words.filter(w => low.includes(w)).length;
    if (hits / words.length < 0.5) missing.push(c);
  }
  return missing;
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
// During the pilot, never cache the front-end files — so code changes always
// take effect on refresh and you never run a stale copy.
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res) => res.setHeader("Cache-Control", "no-store, must-revalidate")
}));

// ---------- uploads ----------
const uploadPdf = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const uploadVideo = multer({
  storage: multer.diskStorage({
    destination: store.VIDEO_DIR,
    filename: (req, file, cb) => {
      const ext = /mp4/.test(file.mimetype || "") ? ".mp4" : /ogg/.test(file.mimetype || "") ? ".ogg" : ".webm";
      cb(null, store.uid() + ext);
    }
  }),
  limits: { fileSize: 300 * 1024 * 1024 }
});
const uploadRec = uploadVideo.fields([{ name: "video", maxCount: 1 }, { name: "audio", maxCount: 1 }]);
// small per-question audio clips (uploaded live during the session)
const uploadSegment = multer({
  storage: multer.diskStorage({
    destination: store.VIDEO_DIR,
    filename: (req, file, cb) => cb(null, store.uid() + (/mp4/.test(file.mimetype || "") ? ".mp4" : /ogg/.test(file.mimetype || "") ? ".ogg" : ".webm"))
  }),
  limits: { fileSize: 25 * 1024 * 1024 }
}).single("audio");
// in-memory upload for the transcribe endpoint (we need the raw buffer to send to Whisper)
const uploadMem = multer({ limits: { fileSize: 25 * 1024 * 1024 } }).single("audio");

// ---------- instructor gate (simple, for the pilot) ----------
function requireInstructor(req, res, next) {
  const pw = process.env.INSTRUCTOR_PASSWORD;
  if (!pw) return next();
  const given = req.get("x-instructor-key") || req.query.key;
  if (given === pw) return next();
  return res.status(401).json({ error: "unauthorized" });
}

// ---------- health / config ----------
app.get("/api/health", (req, res) => {
  // Persistence self-test: a marker file written once. If storage is durable, it
  // survives restarts (same timestamp); if ephemeral, each restart makes a new one.
  let diskMarker = null;
  try {
    const marker = path.join(store.DATA_DIR, ".persist-test");
    if (fs.existsSync(marker)) diskMarker = fs.readFileSync(marker, "utf8");
    else { diskMarker = "first-write-" + new Date().toISOString(); fs.writeFileSync(marker, diskMarker); }
  } catch (e) { diskMarker = "ERROR: " + e.message; }
  res.json({
    ok: true,
    hasKey: !!process.env.ANTHROPIC_API_KEY,
    whisper: whisper.available(),
    model: claude.MODEL,
    needsPassword: !!process.env.INSTRUCTOR_PASSWORD,
    dataDir: store.DATA_DIR,
    diskMarker
  });
});
app.post("/api/login", (req, res) => {
  const pw = process.env.INSTRUCTOR_PASSWORD;
  if (!pw) return res.json({ ok: true, token: "" });
  if ((req.body && req.body.password) === pw) return res.json({ ok: true, token: pw });
  res.status(401).json({ error: "wrong password" });
});

// ---------- assignments ----------
app.post("/api/assignments", requireInstructor, uploadPdf.single("pdf"), async (req, res) => {
  try {
    const b = req.body;
    const existing = b.id ? store.getAssignment(b.id) : null;
    let readingText = (b.readingText || "").trim();
    let wordCount = readingText ? readingText.split(/\s+/).length : 0;
    let numPages = null;
    let pageRange = (b.startPage && b.endPage) ? `${b.startPage}–${b.endPage}` : "";

    if (req.file) {
      const start = b.startPage ? parseInt(b.startPage, 10) : null;
      const end = b.endPage ? parseInt(b.endPage, 10) : null;
      const out = await pdf.extractText(req.file.buffer, start, end);
      readingText = out.text;
      wordCount = out.wordCount;
      numPages = out.numPages;
    }

    // Editing an existing assignment without supplying new material (no new PDF and no
    // pasted text) must NOT wipe the source doc. A file input can't be pre-filled, so an
    // edit-and-save arrives with no file — keep whatever material is already on record.
    if (existing && !req.file && !readingText) {
      readingText = existing.readingText || "";
      wordCount = existing.wordCount || 0;
      numPages = existing.numPages ?? null;
      pageRange = existing.pageRange || "";
    }

    readingText = normalizeSourceDoc(readingText); // #10: ASCII-safe the source text

    const concepts = [];
    for (let i = 1; i <= 6; i++) {
      const v = b["concept" + i];
      if (v && v.trim()) concepts.push(v.trim());
    }

    const assignment = {
      id: existing ? b.id : store.uid(),
      title: b.title || "Untitled reading",
      subject: b.subject || "",
      gradeLevel: b.gradeLevel || "College",
      readingText,
      wordCount,
      numPages,
      pageRange,
      tuning: b.tuning || "ai",        // 'concepts' | 'ai'
      concepts: (b.tuning === "concepts") ? concepts : [],
      requireCamera: b.requireCamera !== "false",
      coachMode: b.coachMode === "coaching" ? "coaching" : "assessment", // default: assess (don't supply answers)
      avOptional: b.avOptional === "1", // accommodation: don't hard-block start if AV unavailable
      showReading: b.showReading === "true", // default false — source doc is the AI's private key
      feedbackMode: b.feedbackMode || "approve", // 'approve' | 'immediate'
      waitingTime: parseInt(b.waitingTime || "0", 10),
      answerLimit: parseInt(b.answerLimit || "0", 10),
      answerWindow: parseInt(b.answerWindow || "0", 10),
      minWords: parseInt(b.minWords || "10", 10),
      maxQuestions: parseInt(b.maxQuestions || "5", 10),
      requireStudentWork: b.requireStudentWork !== "false", // COM 382: students paste their own work first
      // what they paste: "concept" (definition + indicators) or "essay" (a written analysis). The form
      // sends requireStudentWork = "true" | "essay" | "false"; older assignments have no workType = concept.
      workType: b.requireStudentWork === "essay" ? "essay" : "concept",
      finalQuestion: (b.finalQuestion || "").trim(),
      createdAt: existing?.createdAt || Date.now()
    };
    store.saveAssignment(assignment);
    // #10: warn (don't block) if a configured concept doesn't appear to be covered by the source doc
    const conceptWarnings = (assignment.tuning === "concepts" && !assignment.requireStudentWork) ? missingConcepts(assignment.concepts, assignment.readingText) : [];
    res.json({ ...assignment, conceptWarnings });
  } catch (e) {
    console.error("assignment save failed:", e);
    res.status(500).json({ error: "Could not read that PDF. Try the Text option, or a different PDF." });
  }
});

app.get("/api/assignments", requireInstructor, (req, res) => {
  const subs = store.getSubmissions();
  const list = store.getAssignments().map(a => ({
    ...a,
    readingText: undefined, // keep list light
    responseCount: subs.filter(s => s.assignmentId === a.id).length
  }));
  res.json(list);
});

// student needs this to run the session (no instructor key required)
app.get("/api/assignments/:id/run", (req, res) => {
  const a = store.getAssignment(req.params.id);
  if (!a) return res.status(404).json({ error: "Assignment not found" });
  res.json({
    id: a.id, title: a.title, subject: a.subject, gradeLevel: a.gradeLevel,
    // readingText is the AI's private source of truth — only sent to the student if explicitly opted in
    readingText: a.showReading ? a.readingText : "",
    showReading: !!a.showReading,
    requireCamera: a.requireCamera, waitingTime: a.waitingTime, minWords: a.minWords,
    answerLimit: a.answerLimit || 0,
    answerWindow: a.answerWindow || 0,
    avOptional: !!a.avOptional,
    requireStudentWork: a.requireStudentWork !== false,
    workType: a.workType === "essay" ? "essay" : "concept"
  });
});

app.delete("/api/assignments/:id", requireInstructor, (req, res) => {
  store.deleteAssignment(req.params.id);
  res.json({ ok: true });
});

// ---------- live conversation ----------
app.post("/api/conversation", async (req, res) => {
  try {
    const { assignmentId, student, history, seed, sessionId, studentWork } = req.body;
    const assignment = store.getAssignment(assignmentId);
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });
    // sanity cap: a real session is ~16 turns; reject an absurd history (cost-abuse guard on this unauthenticated endpoint)
    if (Array.isArray(history) && history.length > 100) return res.status(400).json({ error: "Conversation too long." });
    // REDO detection (by email): if this student already has a prior attempt at this assignment,
    // have the coach use fresh scenarios/framings, go deeper, and avoid the questions they already saw.
    const email = ((student && student.email) || "").trim().toLowerCase();
    const priorAttempts = email
      ? store.getSubmissions().filter(s => s.assignmentId === assignmentId && ((s.studentEmail || "").trim().toLowerCase() === email) && s.sessionId !== sessionId)
      : [];
    const priorQuestions = priorAttempts
      .flatMap(s => (s.history || []).filter(h => h && h.role === "tutor").map(h => h.text))
      .filter(Boolean).slice(0, 30);
    const turn = await claude.nextTurn({
      assignment,
      student: student || { name: "the student" },
      history: Array.isArray(history) ? history : [],
      maxTurns: (() => {
        const cc = (assignment.concepts || []).filter(Boolean).length;
        const base = assignment.maxQuestions || 5;
        // Guarantee room to ASK every concept (incl. the last) even if a couple get
        // re-asked, so the tail concept (e.g. digital inequality) is never truncated.
        const fq = assignment.finalQuestion ? 1 : 0; // room for the required final question
        return (cc ? Math.max(base, cc + 2) : base) + fq;
      })(),
      studentWork,
      seed: seed || 1,
      isRedo: priorAttempts.length > 0,
      attemptNumber: priorAttempts.length + 1,
      priorQuestions
    });
    res.json(turn);
  } catch (e) {
    if (e.code === "NO_API_KEY") {
      return res.status(503).json({ error: "The app has no Anthropic API key yet. Add it to the .env file and restart." });
    }
    console.error("conversation error:", e.message);
    res.status(500).json({ error: "The AI had trouble responding. Please try again." });
  }
});

// ---------- autosave progress (so a crashed/closed session is still visible) ----------
app.post("/api/progress", (req, res) => {
  try {
    const { sessionId, assignmentId, student, history, startedAt } = req.body || {};
    if (!sessionId || !assignmentId) return res.status(400).json({ error: "bad progress" });
    const assignment = store.getAssignment(assignmentId);
    let s = store.getSubmissions().find(x => x.sessionId === sessionId);
    if (!s) {
      s = {
        id: store.uid(), sessionId, assignmentId,
        assignmentTitle: assignment ? assignment.title : "(assignment)",
        studentName: (student && student.name) || "Unknown",
        studentEmail: (student && student.email) || "",
        studentId: (student && student.id) || "",
        history: [], videoFile: null, videoError: null,
        startedAt: startedAt || Date.now(), endedAt: null,
        flaggedPaste: false, flaggedTimeOver: false, flaggedEdited: false, avStatus: null, recordingGaps: [], audioSegments: [], submittedAt: Date.now(),
        feedback: null, suggestedScore: null, scoreRationale: "", grade: null,
        feedbackApproved: false, status: "in-progress"
      };
    }
    if (Array.isArray(history)) {
      s.history = history;
      s.flaggedEdited = history.some(h => h && h.edited);
    }
    if (Array.isArray(req.body.awayEvents)) { s.awayEvents = req.body.awayEvents; s.tabAway = req.body.awayEvents.length; }
    if (Array.isArray(req.body.copyEvents)) { s.copyEvents = req.body.copyEvents; s.copies = req.body.copyEvents.length; }
    if (Array.isArray(req.body.pasteEvents)) s.pasteEvents = req.body.pasteEvents;
    if (req.body.setupInfo && typeof req.body.setupInfo === "object") s.setupInfo = req.body.setupInfo;
    if (req.body.studentWork) { const w = claude.cleanWork(req.body.studentWork); if (w) s.studentWork = w; }
    s.endedAt = Date.now();
    store.saveSubmission(s);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "progress save failed" }); }
});

// ---------- per-question audio clip (uploaded live during the session) ----------
app.post("/api/segment", (req, res) => {
  uploadSegment(req, res, (err) => {
    try {
      if (err) { console.error("segment upload issue:", err.code || err.message); return res.status(200).json({ ok: false }); }
      const { sessionId, assignmentId, q } = req.body;
      const f = req.file;
      if (!sessionId || !f) return res.status(400).json({ error: "bad segment" });
      // attach to the (possibly in-progress) submission for this session, creating a stub if needed
      let s = store.getSubmissions().find(x => x.sessionId === sessionId);
      if (!s) {
        const a = store.getAssignment(assignmentId);
        s = {
          id: store.uid(), sessionId, assignmentId,
          assignmentTitle: a ? a.title : "(assignment)",
          studentName: req.body.studentName || "Unknown", studentEmail: "", studentId: "",
          history: [], status: "in-progress", startedAt: Date.now(), submittedAt: Date.now(), audioSegments: []
        };
      }
      if (!Array.isArray(s.audioSegments)) s.audioSegments = [];
      s.audioSegments.push({ q: parseInt(q, 10) || 0, file: f.filename });
      store.saveSubmission(s);
      res.json({ ok: true });
    } catch (e) { console.error("segment error:", e.message); res.status(500).json({ error: "segment failed" }); }
  });
});

// ---------- per-answer server-side transcription (Whisper) + store the audio clip ----------
// The client sends each answer's audio here on "Send"; we store it as the per-question backup AND
// return an accurate transcript. Immune to the student's mic routing / connection / browser.
app.post("/api/transcribe", (req, res) => {
  uploadMem(req, res, async (err) => {
    try {
      if (err) { console.error("transcribe upload issue:", err.code || err.message); return res.status(200).json({ text: "", stored: false }); }
      const { sessionId, assignmentId, q } = req.body;
      const f = req.file;
      if (!sessionId || !f) return res.status(400).json({ error: "bad transcribe request", text: "" });
      // 1) store the audio as the durable per-question backup (same as /api/segment)
      let stored = false;
      try {
        const ext = /mp4/.test(f.mimetype || "") ? ".mp4" : /ogg/.test(f.mimetype || "") ? ".ogg" : ".webm";
        const filename = store.uid() + ext;
        fs.writeFileSync(path.join(store.VIDEO_DIR, filename), f.buffer);
        let s = store.getSubmissions().find(x => x.sessionId === sessionId);
        if (!s) {
          const a = store.getAssignment(assignmentId);
          s = { id: store.uid(), sessionId, assignmentId, assignmentTitle: a ? a.title : "(assignment)", studentName: req.body.studentName || "Unknown", studentEmail: "", studentId: "", history: [], status: "in-progress", startedAt: Date.now(), submittedAt: Date.now(), audioSegments: [] };
        }
        if (!Array.isArray(s.audioSegments)) s.audioSegments = [];
        s.audioSegments.push({ q: parseInt(q, 10) || 0, file: filename });
        store.saveSubmission(s);
        stored = true;
      } catch (e) { console.error("transcribe store issue:", e.message); }
      // 2) transcribe — graceful: empty text on any failure, so the client falls back to browser text
      let text = "";
      try { text = await whisper.transcribe(f.buffer, f.mimetype); }
      catch (e) { if (e.code !== "NO_OPENAI_KEY") console.error("whisper error:", e.message); }
      res.json({ text, stored });
    } catch (e) { console.error("transcribe error:", e.message); res.status(200).json({ text: "", stored: false }); }
  });
});

// ---------- submit a completed session ----------
app.post("/api/submit", (req, res) => {
  // Run multer manually so that even if the VIDEO fails (e.g. too large), we still
  // save the transcript — the text fields are parsed before the file, so req.body has them.
  uploadRec(req, res, async (uploadErr) => {
  try {
    if (uploadErr) console.error("video upload issue:", uploadErr.code || uploadErr.message);
    const assignmentId = req.body.assignmentId;
    const assignment = store.getAssignment(assignmentId);
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    let history = [];
    try { history = JSON.parse(req.body.history || "[]"); } catch {}
    const student = { name: req.body.studentName || "Unknown", id: req.body.studentId || "", email: req.body.studentEmail || "" };

    // If this session was being autosaved (progress), complete that record instead of duplicating.
    const sessionId = req.body.sessionId || null;
    const existing = sessionId ? store.getSubmissions().find(x => x.sessionId === sessionId) : null;
    const submission = existing || {
      id: store.uid(), sessionId,
      feedback: null, suggestedScore: null, scoreRationale: "", grade: null, feedbackApproved: false
    };
    submission.assignmentId = assignmentId;
    submission.assignmentTitle = assignment.title;
    submission.studentName = student.name;
    submission.studentEmail = student.email;
    submission.studentId = student.id;
    submission.history = history;
    const vF = req.files && req.files.video && req.files.video[0];
    const aF = req.files && req.files.audio && req.files.audio[0];
    submission.videoFile = vF ? vF.filename : (submission.videoFile || null);
    submission.audioFile = aF ? aF.filename : (submission.audioFile || null);
    submission.videoError = uploadErr ? (uploadErr.code === "LIMIT_FILE_SIZE" ? "Recording too large to store — transcript saved." : "Recording upload failed — transcript saved.") : null;
    submission.startedAt = parseInt(req.body.startedAt, 10) || submission.startedAt || null;
    submission.endedAt = parseInt(req.body.endedAt, 10) || Date.now();
    submission.flaggedPaste = !!req.body.flaggedPaste;
    submission.flaggedTimeOver = !!req.body.flaggedTimeOver;
    submission.flaggedEdited = Array.isArray(history) && history.some(h => h && h.edited);
    const parseArr = (s) => { try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
    submission.awayEvents = parseArr(req.body.awayEvents);
    submission.copyEvents = parseArr(req.body.copyEvents);
    submission.pasteEvents = parseArr(req.body.pasteEvents);
    try { const si = JSON.parse(req.body.setupInfo || "null"); if (si && typeof si === "object") submission.setupInfo = si; } catch {}
    try { const w = claude.cleanWork(JSON.parse(req.body.studentWork || "null")); if (w) submission.studentWork = w; } catch {}
    submission.tabAway = submission.awayEvents.length;
    submission.copies = submission.copyEvents.length;
    // AV status: missing (no recording), partial (gaps / stopped early / upload error), or ok
    submission.recordingGaps = parseArr(req.body.recordingGaps);
    const hasContinuous = !!(submission.videoFile || submission.audioFile);
    const segCount = Array.isArray(submission.audioSegments) ? submission.audioSegments.length : 0;
    const hasRec = hasContinuous || segCount > 0;
    // partial if the full recording dropped/failed but we still have SOME audio (per-question clips or a gappy file)
    const partialAV = hasRec && (!hasContinuous || submission.recordingGaps.length > 0 || !!req.body.recordingStoppedEarly || !!submission.videoError);
    submission.avStatus = !hasRec ? "missing" : (partialAV ? "partial" : "ok");
    // record which version of the source document the coach was working from (per #10)
    submission.sourceDocHash = assignment.readingText
      ? crypto.createHash("sha256").update(assignment.readingText).digest("hex").slice(0, 12) : null;
    submission.coachMode = assignment.coachMode || "assessment";
    // attempt number for this student+assignment (by email) — so redos are visible in the dashboard
    const emailLc = (student.email || "").trim().toLowerCase();
    submission.attemptNumber = 1 + (emailLc
      ? store.getSubmissions().filter(x => x.assignmentId === assignmentId && ((x.studentEmail || "").trim().toLowerCase() === emailLc) && x.sessionId !== sessionId).length
      : 0);
    submission.submittedAt = Date.now();
    submission.status = "complete";

    // generate feedback + a suggested score now (instructor reviews/overrides the grade)
    if (process.env.ANTHROPIC_API_KEY && history.length && !submission.feedback) {
      try {
        const a = await claude.generateFeedback({ assignment, student, history, studentWork: submission.studentWork });
        submission.feedback = a.feedback;
        submission.suggestedScore = a.suggestedScore;
        submission.scoreRationale = a.scoreRationale;
        submission.feedbackApproved = (assignment.feedbackMode === "immediate");
      } catch (e) { console.error("feedback gen failed:", e.message); }
    }

    store.saveSubmission(submission);
    res.json({
      ok: true, submissionId: submission.id,
      videoBytes: vF ? vF.size : 0, audioBytes: aF ? aF.size : 0, avStatus: submission.avStatus,
      feedbackShared: submission.feedbackApproved, feedback: submission.feedbackApproved ? submission.feedback : null
    });
  } catch (e) {
    console.error("submit error:", e);
    res.status(500).json({ error: "Could not save your submission." });
  }
  });
});

// ---------- structured (JSON) export — a stable, machine-readable schema for scripting/forensics ----------
function buildStructured(s, assignment) {
  const iso = ms => (ms ? new Date(ms).toISOString() : null);
  const hist = Array.isArray(s.history) ? s.history : [];
  // pair each Coach turn (a question) with the student turn that follows it
  const questions = [];
  for (let i = 0; i < hist.length; i++) {
    if (hist[i].role !== "tutor") continue;
    const prompt = hist[i];
    const ans = (hist[i + 1] && hist[i + 1].role === "student") ? hist[i + 1] : null;
    let pauseSec = null, speakSec = null, pauseBasis = null;
    if (ans && prompt.at && ans.at && ans.firstWordAt && ans.firstWordAt <= ans.at) {
      // Measure the pause from when the mic actually opened (coach done reading the question aloud),
      // NOT from when the question text appeared — otherwise the coach's text-to-speech time is
      // wrongly counted as the student's pause. Fall back to prompt time for older sessions.
      const base = (ans.readyAt && ans.firstWordAt >= ans.readyAt) ? ans.readyAt : prompt.at;
      pauseBasis = (ans.readyAt && ans.firstWordAt >= ans.readyAt) ? "mic_open" : "question_shown_(includes_coach_reading_it_aloud)";
      if (ans.firstWordAt >= base) {
        pauseSec = Math.round((ans.firstWordAt - base) / 1000);
        speakSec = Math.round((ans.at - ans.firstWordAt) / 1000);
      }
    }
    questions.push({
      index: questions.length + 1,
      prompt: prompt.text,
      promptAtUTC: iso(prompt.at),
      promptVideoOffsetMs: prompt.videoOffsetMs == null ? null : prompt.videoOffsetMs,
      answer: ans ? {
        status: "answered",
        text: ans.text,
        transcriptSource: ans.edited ? "student_edited" : "raw_asr", // raw speech-to-text vs. the student hand-editing it
        rawAsrTranscript: ans.spoken || null,
        transcriptEditedByStudent: !!ans.edited,
        startedSpeakingAtUTC: iso(ans.firstWordAt),
        submittedAtUTC: iso(ans.at),
        pauseBeforeSpeakingSec: pauseSec,
        pauseMeasuredFrom: pauseBasis, // "mic_open" = true silent pause; the older basis includes the coach reading the question aloud
        speakingSec: speakSec,
        videoOffsetMs: ans.videoOffsetMs == null ? null : ans.videoOffsetMs
      } : { status: "not_answered", note: "Coach asked this but no student answer was recorded (session ended or was cut off)." }
    });
  }
  // typed event log with absolute UTC timestamps
  const events = [];
  for (const e of (s.awayEvents || [])) events.push({ type: "page_leave", atUTC: iso(e.at), endAtUTC: iso(e.at && e.durationMs ? e.at + e.durationMs : null), durationSec: e.durationMs ? Math.round(e.durationMs / 1000) : null, videoOffsetMs: e.videoOffsetMs == null ? null : e.videoOffsetMs, question: e.q == null ? null : e.q });
  for (const e of (s.copyEvents || [])) events.push({ type: "copy", atUTC: iso(e.at), text: e.text || "", videoOffsetMs: e.videoOffsetMs == null ? null : e.videoOffsetMs, question: e.q == null ? null : e.q });
  for (const e of (s.pasteEvents || [])) events.push({ type: "paste_attempt", atUTC: iso(e.at), text: e.text || "", videoOffsetMs: e.videoOffsetMs == null ? null : e.videoOffsetMs, question: e.q == null ? null : e.q });
  for (const g of (s.recordingGaps || [])) events.push({ type: "capture_gap", reason: g.reason || "", startVideoOffsetMs: g.startOffsetMs == null ? null : g.startOffsetMs, endVideoOffsetMs: g.endOffsetMs == null ? null : g.endOffsetMs });
  events.sort((a, b) => (a.atUTC || "").localeCompare(b.atUTC || ""));
  // derived behavioral summary (so the instructor doesn't recompute these by hand)
  const away = s.awayEvents || [];
  const offPageByQuestion = {};
  let totalOff = 0, longest = 0;
  for (const e of away) { const sec = e.durationMs ? e.durationMs / 1000 : 0; totalOff += sec; if (sec > longest) longest = sec; const q = e.q || 0; offPageByQuestion[q] = (offPageByQuestion[q] || 0) + sec; }
  let maxPause = 0;
  for (const q of questions) if (q.answer && q.answer.pauseBeforeSpeakingSec > maxPause) maxPause = q.answer.pauseBeforeSpeakingSec;
  const behavioralSummary = {
    totalOffPageSec: Math.round(totalOff),
    offPageByQuestionSec: Object.fromEntries(Object.entries(offPageByQuestion).map(([k, v]) => [k, Math.round(v)])),
    longestLeaveSec: Math.round(longest),
    tabAways: away.length,
    copies: (s.copyEvents || []).length,
    pasteAttempts: (s.pasteEvents || []).length,
    longestPauseBeforeSpeakingSec: maxPause,
    wentOverTimeLimit: !!s.flaggedTimeOver,
    questionsAsked: questions.length,
    questionsAnswered: questions.filter(q => q.answer && q.answer.status === "answered").length
  };
  return {
    schemaVersion: 1,
    studentWork: s.studentWork || null,
    session: {
      submissionId: s.id, sessionId: s.sessionId || null,
      assignmentId: s.assignmentId, assignmentTitle: s.assignmentTitle,
      student: { name: s.studentName, email: s.studentEmail || "", id: s.studentId || "" },
      startedAtUTC: iso(s.startedAt), endedAtUTC: iso(s.endedAt), submittedAtUTC: iso(s.submittedAt),
      durationSec: (s.startedAt && s.endedAt) ? Math.round((s.endedAt - s.startedAt) / 1000) : null,
      status: s.status, avStatus: s.avStatus || null, recordingGaps: s.recordingGaps || [],
      coachMode: s.coachMode || (assignment && assignment.coachMode) || "assessment",
      sourceDocHash: s.sourceDocHash || null,
      configuredConcepts: (assignment && assignment.concepts) || []
    },
    // everything needed to diagnose WHY a recording did or didn't capture, in one place
    capture: {
      status: s.status,
      avStatus: s.avStatus || null,
      completed: s.status !== "in-progress",
      hasVideo: !!s.videoFile,
      hasContinuousAudio: !!s.audioFile,
      perQuestionAudioClips: (s.audioSegments || []).length,
      videoError: s.videoError || null,
      recordingGaps: s.recordingGaps || [],
      attemptNumber: s.attemptNumber || 1,
      setup: s.setupInfo || null // browser, mic permission, speech-init, recorder-start (null for pre-diagnostics sessions)
    },
    questions, events, behavioralSummary,
    grading: { aiSuggestedScore: s.suggestedScore == null ? null : s.suggestedScore, scoreRationale: s.scoreRationale || "", instructorGrade: s.grade == null ? null : s.grade, aiFeedback: s.feedback || null }
  };
}
const safeFile = str => String(str || "export").replace(/[^a-z0-9]+/gi, "_").slice(0, 60);
app.get("/api/submissions/:id/export.json", requireInstructor, (req, res) => {
  const s = store.getSubmission(req.params.id);
  if (!s) return res.status(404).json({ error: "Submission not found" });
  const obj = buildStructured(s, store.getAssignment(s.assignmentId));
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=${safeFile(s.studentName)}_${safeFile(s.assignmentTitle)}.json`);
  res.send(JSON.stringify(obj, null, 2));
});
app.get("/api/submissions.json", requireInstructor, (req, res) => {
  const sel = req.query.assignmentId;
  let subs = store.getSubmissions();
  if (sel) subs = subs.filter(s => s.assignmentId === sel);
  const out = subs.map(s => buildStructured(s, store.getAssignment(s.assignmentId)));
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=com382-submissions.json`);
  res.send(JSON.stringify({ schemaVersion: 1, exportedAtUTC: new Date().toISOString(), count: out.length, submissions: out }, null, 2));
});

// ---------- instructor dashboard ----------
app.get("/api/submissions", requireInstructor, (req, res) => {
  const list = store.getSubmissions().map(s => ({
    ...s,
    hasVideo: !!s.videoFile,
    hasAudio: !!s.audioFile,
    segmentQs: (s.audioSegments || []).map(x => x.q),
    videoFile: undefined,
    audioFile: undefined,
    audioSegments: undefined
  }));
  res.json(list);
});
// Coach-talk / silence totals (seconds) from the per-turn offsets the student page records.
// Blank for older sessions that predate this timing capture.
function talkTotals(s) {
  const hist = Array.isArray(s.history) ? s.history : [];
  let coach = 0, before = 0, after = 0, have = false;
  for (let i = 0; i < hist.length; i++) {
    const h = hist[i];
    if (h.role !== "tutor") continue;
    const cStart = h.spokenStartOffsetMs, cEnd = h.spokenEndOffsetMs;
    if (cStart != null && cEnd != null && cEnd >= cStart) { coach += cEnd - cStart; have = true; }
    const stu = hist.slice(i + 1).find(x => x.role === "student");
    if (!stu) continue;
    if (cEnd != null && stu.firstWordOffsetMs != null && stu.firstWordOffsetMs >= cEnd) before += stu.firstWordOffsetMs - cEnd;
    if (stu.lastWordOffsetMs != null && stu.videoOffsetMs != null && stu.videoOffsetMs >= stu.lastWordOffsetMs) { after += stu.videoOffsetMs - stu.lastWordOffsetMs; have = true; }
  }
  const sec = ms => have ? Math.round(ms / 1000) : "";
  return { coach: sec(coach), before: sec(before), after: sec(after) };
}
app.get("/api/submissions.csv", requireInstructor, (req, res) => {
  const sel = req.query.assignmentId;
  let subs = store.getSubmissions();
  if (sel) subs = subs.filter(s => s.assignmentId === sel);
  const q = v => {
    let s = String(v == null ? "" : v);
    // neutralize CSV/Excel formula injection (cells starting with = + - @ tab CR)
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const head = ["Student", "Email", "StudentID", "Assignment", "Status", "AVStatus", "Started", "DurationSec", "CoachTalkSec", "SilentBeforeSec", "SilentAfterSec", "Submitted", "Grade", "AISuggestedScore", "FlaggedPaste", "FlaggedTimeOver", "EditedTranscript", "TabSwitches", "Copies", "CopiedText", "PastedText", "FeedbackShared", "StudentConcept", "StudentDefinition", "StudentIndicators", "StudentValidityReliability", "Transcript", "Feedback", "StudentWrittenAnalysis", "StudentDocLink"];
  const lines = subs.map(s => {
    const dur = (s.startedAt && s.endedAt) ? Math.round((s.endedAt - s.startedAt) / 1000) : "";
    const t = talkTotals(s);
    const transcript = (s.history || []).map(h => `${h.role === "tutor" ? "Coach" : s.studentName}: ${h.text}`).join("\n");
    return [
      s.studentName, s.studentEmail, s.studentId, s.assignmentTitle,
      s.status === "in-progress" ? "INCOMPLETE" : "complete",
      s.avStatus || "",
      s.startedAt ? new Date(s.startedAt).toLocaleString() : "",
      dur, t.coach, t.before, t.after, new Date(s.submittedAt).toLocaleString(),
      s.grade == null ? "" : s.grade, s.suggestedScore == null ? "" : s.suggestedScore,
      s.flaggedPaste ? "YES" : "", s.flaggedTimeOver ? "YES" : "", s.flaggedEdited ? "YES" : "", s.tabAway || 0, s.copies || 0,
      (s.copyEvents || []).map(c => c.text).join("  |  "), (s.pasteEvents || []).map(p => p.text).join("  |  "),
      s.feedbackApproved ? "YES" : "",
      (s.studentWork && s.studentWork.concept) || "", (s.studentWork && s.studentWork.definition) || "", (s.studentWork && s.studentWork.indicators) || "", (s.studentWork && s.studentWork.validity) || "",
      transcript, s.feedback || "",
      (s.studentWork && s.studentWork.essay) || "", (s.studentWork && s.studentWork.docLink) || ""
    ].map(q).join(",");
  });
  const BOM = String.fromCharCode(0xFEFF); // so Excel reads it as UTF-8
  const csv = BOM + [head.join(","), ...lines].join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=com382-submissions.csv");
  res.send(csv);
});

// Bulk-download all recordings (video + audio backups) for the filter as one zip — for offloading.
app.get("/api/videos.zip", requireInstructor, (req, res) => {
  const sel = req.query.assignmentId;
  let subs = store.getSubmissions().filter(s => s.videoFile || s.audioFile || (s.audioSegments && s.audioSegments.length));
  if (sel) subs = subs.filter(s => s.assignmentId === sel);
  const files = [];
  for (const s of subs) {
    const base = (s.studentName || "student").replace(/[^\w.-]+/g, "_") + "__" + s.id;
    if (s.videoFile) { const p = path.join(store.VIDEO_DIR, s.videoFile); if (fs.existsSync(p)) files.push({ p, name: base + path.extname(s.videoFile) }); }
    if (s.audioFile) { const p = path.join(store.VIDEO_DIR, s.audioFile); if (fs.existsSync(p)) files.push({ p, name: base + "_audio" + path.extname(s.audioFile) }); }
    for (const seg of (s.audioSegments || [])) { const p = path.join(store.VIDEO_DIR, seg.file); if (fs.existsSync(p)) files.push({ p, name: base + "_q" + seg.q + "_audio" + path.extname(seg.file) }); }
  }
  if (!files.length) return res.status(404).send("No recordings to download.");
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", "attachment; filename=com382-recordings.zip");
  const archive = archiver("zip", { zlib: { level: 0 } }); // store mode — media is already compressed
  archive.on("error", err => { console.error("zip error:", err.message); try { res.destroy(); } catch {} });
  archive.pipe(res);
  for (const { p, name } of files) archive.file(p, { name });
  archive.finalize();
});

// Delete videos (keep transcripts/grades) to free disk space — after you've offloaded.
app.post("/api/purge-videos", requireInstructor, (req, res) => {
  const sel = req.body && req.body.assignmentId;
  let subs = store.getSubmissions();
  if (sel) subs = subs.filter(s => s.assignmentId === sel);
  let purged = 0;
  for (const s of subs) {
    let did = false;
    for (const key of ["videoFile", "audioFile"]) {
      if (s[key]) {
        const p = path.join(store.VIDEO_DIR, s[key]);
        if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
        s[key] = null; did = true;
      }
    }
    for (const seg of (s.audioSegments || [])) {
      const p = path.join(store.VIDEO_DIR, seg.file);
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
      did = true;
    }
    if (s.audioSegments && s.audioSegments.length) s.audioSegments = [];
    if (did) { s.videoPurgedAt = Date.now(); store.saveSubmission(s); purged++; }
  }
  res.json({ ok: true, purged });
});

app.get("/api/submissions/:id", requireInstructor, (req, res) => {
  const s = store.getSubmission(req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  res.json({ ...s, hasVideo: !!s.videoFile, hasAudio: !!s.audioFile, segmentQs: (s.audioSegments || []).map(x => x.q) });
});
app.get("/api/audio/:id", requireInstructor, (req, res) => {
  const s = store.getSubmission(req.params.id);
  if (!s || !s.audioFile) return res.status(404).send("No audio");
  const p = path.join(store.VIDEO_DIR, s.audioFile);
  if (!fs.existsSync(p)) return res.status(404).send("Audio file missing");
  res.sendFile(p);
});
app.get("/api/video/:id", requireInstructor, (req, res) => {
  const s = store.getSubmission(req.params.id);
  if (!s || !s.videoFile) return res.status(404).send("No video");
  const p = path.join(store.VIDEO_DIR, s.videoFile);
  if (!fs.existsSync(p)) return res.status(404).send("Video file missing");
  res.sendFile(p);
});
app.get("/api/segment/:id/:q", requireInstructor, (req, res) => {
  const s = store.getSubmission(req.params.id);
  const seg = s && Array.isArray(s.audioSegments) && s.audioSegments.find(x => String(x.q) === String(req.params.q));
  if (!seg) return res.status(404).send("No segment");
  const p = path.join(store.VIDEO_DIR, seg.file);
  if (!fs.existsSync(p)) return res.status(404).send("Segment file missing");
  res.sendFile(p);
});
app.post("/api/submissions/:id/feedback", requireInstructor, async (req, res) => {
  const s = store.getSubmission(req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  const assignment = store.getAssignment(s.assignmentId) || { title: s.assignmentTitle };
  try {
    const a = await claude.generateFeedback({ assignment, student: { name: s.studentName }, history: s.history, studentWork: s.studentWork });
    s.feedback = a.feedback; s.suggestedScore = a.suggestedScore; s.scoreRationale = a.scoreRationale;
    store.saveSubmission(s);
    res.json({ feedback: s.feedback, suggestedScore: s.suggestedScore, scoreRationale: s.scoreRationale });
  } catch (e) {
    if (e.code === "NO_API_KEY") return res.status(503).json({ error: "No API key set." });
    res.status(500).json({ error: "Could not generate feedback." });
  }
});
app.post("/api/submissions/:id/grade", requireInstructor, (req, res) => {
  const s = store.getSubmission(req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  s.grade = (req.body.grade == null ? "" : String(req.body.grade)).slice(0, 100);
  store.saveSubmission(s);
  res.json({ ok: true });
});
app.post("/api/submissions/:id/approve", requireInstructor, (req, res) => {
  const s = store.getSubmission(req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  if (typeof req.body.feedback === "string") s.feedback = req.body.feedback;
  s.feedbackApproved = true;
  store.saveSubmission(s);
  res.json({ ok: true });
});
app.delete("/api/submissions/:id", requireInstructor, (req, res) => {
  store.deleteSubmission(req.params.id);
  res.json({ ok: true });
});

// ---------- routes for pages ----------
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log("\n  COM 382 Voice Conversations — running");
  console.log("  Instructor:  http://localhost:" + PORT + "/");
  console.log("  API key set: " + (process.env.ANTHROPIC_API_KEY ? "yes" : "NO  (add it to .env to enable conversations)"));
  console.log("  Model:       " + claude.MODEL + "\n");
});
