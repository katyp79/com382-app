# Testing & hardening notes (while you were away)

Here's what I did after you left. Short version: **the conversation engine is solid**, I found and fixed one crash, and I added two reliability features for a live class. A few things still need *your* live test because they need a real camera/mic (I can't simulate those headlessly).

---

## 1. I stress-tested the conversation engine

I wrote an automated tester that role-plays different student types against the live AI and ran 6 conversations. Results:

| Scenario | Result |
|---|---|
| **Good student** (correct, substantive answers) | ✓ Escalating questions, covered the concepts, warm close at 5 questions |
| **Confused student** (wrong/conflated answers) | ✓ **Corrected each mistake specifically** ("visibility isn't popularity metrics — it's how easily content can be seen"), gave second chances, didn't let them skip the key question, closed kindly with "reread paragraph 1" |
| **Terse student** (one-word answers) | ✓ Gently drew them out, wrapped up without badgering |
| **Empty answer** | ⚠ **Crashed (HTTP 500) → I fixed it** (see below) |
| **Randomization** (same assignment, 2 students) | ✓ Different openers AND different question angles |

The "confused student" handling is the Sherpa behavior you specifically wanted — it works well.

## 2. Bug found and fixed

- **Empty/blank answer crashed the conversation.** Claude rejects empty message text. Your Send button already blocks empty answers, so a *student* can't trigger it — but the engine shouldn't crash regardless. Fixed: a blank turn is now replaced with "(no response given)" and the coach re-prompts. Verified it returns 200 now.

## 3. Reliability features added (for a real class)

- **Retry button.** If a single turn fails (Claude briefly overloaded, a wifi blip), the student now sees a **↻ Retry** button instead of being stuck. Their conversation is preserved.
- **Tab-close warning.** If a student tries to close the tab mid-conversation, the browser now warns them (so they don't lose their work by accident). The warning clears once they've submitted.
- **Prompt caching** (cost cut). The reading/source document is now cached across the turns of a conversation, billed at ~10% after the first turn. This **roughly halves** the per-conversation cost. The server now prints token usage per turn so you can watch it.
- **CSV export for your gradebook.** New **⤓ Export CSV** button on the Submissions tab. Downloads a spreadsheet (student name, UW email, ID, assignment, start time, duration, submit time, the ⚠ paste flag, whether feedback was shared, the full transcript, and the AI feedback) — respecting whichever assignment filter you have selected. Opens cleanly in Excel. Useful for grading and for documenting an integrity case.

## 3b. Transcript-edit transparency (you asked for this)

Students can still fix transcription glitches, but editing is now fully transparent:
- **Student side:** a note under the answer box says their original spoken words and any edits are saved and shown to you. If they change the transcribed text, the note turns amber and says "You've edited the transcript."
- **What's recorded:** the original speech-to-text ("spoken") is saved alongside the final submitted text for every answer.
- **Instructor side:** an edited answer shows a **✎ edited** flag, the **original transcription**, and a **word-level diff** (red = removed, green = added) so you see *exactly* what changed. Submissions with any edit get a **✎ edited** pill in the list and a banner up top. The CSV gains an **EditedTranscript** (YES/NO) column.

Combined with the existing paste-flag and the video, that's three independent signals if someone tries to swap in a "better" answer.

## 3c. Auto-record + closer fix (from your live test)

- **Auto-record.** Students no longer have to click "Start answering." After the coach finishes asking (and after the optional think-time countdown), recording **starts automatically** — they just talk and click **Stop** (or Send) when done. They can still click to start early.
- **Think time before recording.** New setting on the Create form (None / 15 / 30 / **60s like Sherpa**). Set it per assignment; the student sees a countdown, then it auto-records.
- **Closer no longer asks a dead-end question.** Your test ended with the coach asking a reflective question and then immediately quitting — that's fixed. The final turn is now a warm sign-off (reflections are phrased as takeaways, not questions). Verified: the final turn contains no question.

## 3d. Round 2 fixes (from your second live test)

- **Breadth — covers each distinct concept now (the big one).** It was drilling concept #1 and never reaching the rest. Rewrote the engine to ask ~one question per concept and **advance**, even if an answer is imperfect (max two turns on any one concept). Verified with a realistic role-played student: **4 of 4 distinct concepts covered**, one each, then a clean close — the Sherpa "5 distinct concepts" feel.
  - ⚠️ **Set "Number of exchanges" ≈ your number of concepts.** Your "Module 1 test" has **6 concepts but is set to 5 exchanges**, so it can only reach ~5 of them. Edit it and bump exchanges to **6 or 7**.
- **"All done" appeared while the coach was still talking — fixed.** The code was guessing how long speech would take; for a long final message it guessed short and showed "All done" mid-sentence. It now waits for speech to *actually* finish before advancing.
- **Mic picking up the coach's voice — fixed (same root cause).** The mic no longer opens until the coach has truly finished speaking, plus I enabled **echo cancellation / noise suppression** on the microphone (helps a lot when students use speakers instead of headphones).
- **Auto-record didn't reliably start — hardened.** Recognition now restarts robustly between questions, retries once if the browser isn't ready, and falls back to "tap the mic" instead of silently doing nothing. (This one needs your live retest to confirm on your machine — speech-recognition timing is browser-specific.)

## 3e. The real "Open shows nothing" bug — FOUND & FIXED

Root cause was **not** caching (my earlier guess). The timestamp formatter combined `dateStyle`/`timeStyle` with `timeZoneName`, which browsers reject (`TypeError: Invalid option`). So every click of **Open** threw and the panel rendered blank. Found it by reproducing the page headlessly (jsdom) and calling the Open function with real data. Fixed the formatter (explicit date/time components) — verified Open now renders the full transcript, the edit diff, and correct timestamps ("Jun 19, 2026, 12:58:53 PM PDT"). Also hardened: Open is now wrapped so it can never silently blank out (shows an error message instead), and assets are cache-busted (`?v=2`) so stale code can't linger.

## 3f. Round 3 (from your live test)

- **"reading" → "module material"** everywhere — student screens, setup form, and the AI's own words (it no longer says "reading"; verified).
- **Question + answer on one screen** — the answer card now shows **"The coach asked"** with the current question highlighted right above the answer box, so you don't scroll up to the log.
- **False "edited" flag fixed** — it now flags an edit ONLY when the student actually types/edits, not when the speech engine cleans up wording.
- **Per-question/answer timestamps** confirmed present (small grey text after each line; can be made bigger on request).
- **Grading (your "combo of 1 + 2")** — each submission now gets an **AI-suggested score /100 with a one-line rationale**, shown in the dashboard. There's an editable **"Your grade"** field (defaults to the suggestion) you save per student; it also lands in the **CSV** (new `Grade` and `AISuggestedScore` columns). The AI suggests; you decide. Verified end-to-end.

## 3g. Stress test ("try to break it") — results

Ran an adversarial harness. **All green after fixes:**
- **20 students submitting at the exact same instant → all 20 saved, zero lost** (no data race).
- **Malformed/garbage requests, missing fields, non-array data → graceful 4xx, never a crash.**
- **Assignment deleted mid-conversation → clean 404**, no hang.
- **Large module text (~330 KB / 30k words) → accepted.**
- **Corrupt/fake PDF → friendly error, no crash.**

Issues found and fixed:
- **CSV formula injection (real security bug):** a student named `=1+1+cmd|…` would have run as a formula when you opened the CSV in Excel. Now neutralized (such cells are prefixed so Excel treats them as text).
- **Video could cost you a transcript:** if a video upload failed (e.g. an extra-long session over the size limit), the whole submission used to fail. Now the **transcript always saves** even if the video doesn't, and the dashboard notes "video too large — transcript saved."
- **Smaller videos:** capped recording bitrate (~1 Mbps). Your 73 MB / 4-min test would now be ~30 MB — easier on storage and far less likely to hit limits.
- **Timeout protection (what you asked about):** the AI call now times out server-side at 60s (1 retry), and the student side times out at 75s and shows the **Retry** button — so a hung/slow AI never strands a student. Their conversation is preserved across a retry.

## 3h. Crash resilience (you asked: "do they start over?")

The student's browser now **autosaves the transcript to your server after every turn.** So:
- If a student's device crashes / loses power / closes the tab mid-conversation, the partial attempt **still shows in your dashboard**, tagged **⏳ incomplete**, with the transcript up to the crash point. Their effort isn't invisible.
- They restart fresh for a clean recording; the final submission **completes the same record** — no duplicates.
- The CSV gets a **Status** column (complete / INCOMPLETE).
- **Caveat (browser limitation):** the *video* of a crashed attempt can't be recovered — it's held in browser memory until the end. Recovering partial video would require streaming it during the session (the "full crash-proofing" option), which is better suited to the deployed Stage B version.

Verified end-to-end: autosave creates/updates one record (no dupes), a normal finish completes it, and a crash leaves an in-progress record visible.

## 4. What I could NOT test (needs your real browser + camera/mic)

These work in code but I can't exercise them headlessly — please try them in your live test:
- **Voice-to-text accuracy** (the browser's speech recognition) — speak naturally and see how clean the transcript is.
- **Video recording → upload → playback** in your Submissions dashboard.
- **The spoken questions** (browser text-to-speech) — does the pace feel right?
- **The full loop**: record as a student → submit → open it in your dashboard → watch video + read transcript → approve feedback.
- The new **Retry button** and **tab-close warning** (simple logic, but eyeball them).

## 5. Housekeeping

- All my test data was created and deleted cleanly — your data store still holds only your one real assignment and submission.
- Approximate API cost of all this testing: **well under $0.50** (a few cents per conversation, ~8 conversations).
- Remember to **restart the app** (Ctrl+C, then `npm start`) and **hard-refresh** (Ctrl+Shift+R) to load today's changes.

## Suggested next things (your call when you're back)
- Do the live camera/mic test above and tell me anything that feels off.
- Decide whether you want the optional **"Potential Concerns" summary** (Sherpa-style gap list) on each submission.
- When you're happy with the feel → **Stage B: deploy** to a private link so your students can actually use it (needs decisions about hosting + UW-approved storage).
