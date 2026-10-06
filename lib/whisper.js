// Server-side speech-to-text via OpenAI Whisper. Used so transcription doesn't depend on the
// student's browser/mic-routing/connection (the browser Web Speech API fails for remote/international
// students and on Safari/iOS). Optional: if OPENAI_API_KEY isn't set, callers fall back to browser text.

function available() {
  return !!process.env.OPENAI_API_KEY;
}

// buffer: a Buffer/Uint8Array of the audio; mimetype like "audio/webm". Returns the transcript text.
async function transcribe(buffer, mimetype) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) { const e = new Error("NO_OPENAI_KEY"); e.code = "NO_OPENAI_KEY"; throw e; }
  if (!buffer || !buffer.length) return "";
  const ext = /mp4|m4a/.test(mimetype || "") ? "mp4" : /ogg/.test(mimetype || "") ? "ogg" : /wav/.test(mimetype || "") ? "wav" : "webm";

  const fd = new FormData();
  fd.append("file", new Blob([buffer], { type: mimetype || "audio/webm" }), "answer." + ext);
  fd.append("model", process.env.WHISPER_MODEL || "whisper-1");
  fd.append("language", "en");
  fd.append("response_format", "json");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000); // a long answer shouldn't take anywhere near this
  try {
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key },
      body: fd,
      signal: ctrl.signal
    });
    const text = await r.text();
    let d = {}; try { d = JSON.parse(text); } catch {}
    if (!r.ok) throw new Error((d.error && d.error.message) || ("Whisper HTTP " + r.status));
    return (d.text || "").trim();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { transcribe, available };
