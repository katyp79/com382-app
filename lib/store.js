// Tiny file-based data store. No database needed for the local pilot.
// Everything lives under ./data — assignments + submissions as JSON, videos as files.
const fs = require("fs");
const path = require("path");

// Use a persistent disk in production (set DATA_DIR env var); fall back to local ./data for dev.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const VIDEO_DIR = path.join(DATA_DIR, "videos");
const ASSIGNMENTS = path.join(DATA_DIR, "assignments.json");
const SUBMISSIONS = path.join(DATA_DIR, "submissions.json");

function ensure() {
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
  if (!fs.existsSync(ASSIGNMENTS)) fs.writeFileSync(ASSIGNMENTS, "[]");
  if (!fs.existsSync(SUBMISSIONS)) fs.writeFileSync(SUBMISSIONS, "[]");
}
ensure();

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return []; }
}
function write(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

module.exports = {
  DATA_DIR, VIDEO_DIR,
  uid,

  // ---- assignments ----
  getAssignments() { return read(ASSIGNMENTS); },
  getAssignment(id) { return read(ASSIGNMENTS).find(a => a.id === id) || null; },
  saveAssignment(a) {
    const all = read(ASSIGNMENTS);
    const idx = all.findIndex(x => x.id === a.id);
    if (idx >= 0) all[idx] = a; else all.unshift(a);
    write(ASSIGNMENTS, all);
    return a;
  },
  deleteAssignment(id) {
    write(ASSIGNMENTS, read(ASSIGNMENTS).filter(a => a.id !== id));
  },

  // ---- submissions ----
  getSubmissions() { return read(SUBMISSIONS); },
  getSubmission(id) { return read(SUBMISSIONS).find(s => s.id === id) || null; },
  saveSubmission(s) {
    const all = read(SUBMISSIONS);
    const idx = all.findIndex(x => x.id === s.id);
    if (idx >= 0) all[idx] = s; else all.unshift(s);
    write(SUBMISSIONS, all);
    return s;
  },
  deleteSubmission(id) {
    const s = this.getSubmission(id);
    if (s) {
      const files = [s.videoFile, s.audioFile, ...((s.audioSegments || []).map(x => x.file))];
      for (const f of files) {
        if (f) { const p = path.join(VIDEO_DIR, f); if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} } }
      }
    }
    write(SUBMISSIONS, read(SUBMISSIONS).filter(x => x.id !== id));
  },

  // ---- housekeeping: delete videos older than N days (keeps transcripts) ----
  purgeOldVideos(days) {
    const cutoff = Date.now() - days * 86400000;
    const all = read(SUBMISSIONS);
    let purged = 0;
    for (const s of all) {
      if ((s.videoFile || s.audioFile || (s.audioSegments && s.audioSegments.length)) && s.submittedAt < cutoff) {
        for (const f of [s.videoFile, s.audioFile, ...((s.audioSegments || []).map(x => x.file))]) {
          if (f) { const p = path.join(VIDEO_DIR, f); if (fs.existsSync(p)) { try { fs.unlinkSync(p); purged++; } catch {} } }
        }
        s.videoFile = null; s.audioFile = null; s.audioSegments = [];
        s.videoPurgedAt = Date.now();
      }
    }
    if (purged) write(SUBMISSIONS, all);
    return purged;
  }
};
