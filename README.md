# COM 382 — Conceptualization Conversations

A copy of the COM 303 voice-conversation tool, adapted for COM 382. **The COM 303 app is separate and untouched.**

## What is different from COM 303
- **Students paste their own work first:** concept, final conceptual definition (with dimensions), final indicators, and optionally their chatbot transcript.
- **Questions are about their own work:** explaining their dimensions, why each is a component, how an indicator measures a dimension, what a response would mean, why they made a revision.
- **Required final question** (set per assignment), asked last every time. Default: the chatbot reflection.
- **"Potential concerns" in the AI feedback:** specific, quoted signals for you to check (spoken answers that contradict the written work, can't explain own terms, read-aloud answers, AI-looking text). Signals only, never conclusions.
- Student work is shown in the dashboard and included in the CSV and JSON exports.

Suggested setup for an assignment: paste the course guide (1-course-guide.md) as the module material (kept private), choose "specific concepts", and enter targets such as: dimensions as components; distinctness of dimensions; defining their own terms; indicator-to-dimension fit; what a response means; a revision they made.

---

# Original COM 303 notes

A tool where students have a short, **spoken, adaptive conversation** with an AI about an assigned
reading — it listens and asks real follow-up questions — while their **video** is recorded for you to
review alongside a full **transcript**. You set it up; they join by link.

This is the **local pilot** version: it runs on *your* computer so you can try the whole thing before
we put it online for students.

---

## One-time setup (about 5 minutes)

1. **Get an Anthropic API key** (the AI engine):
   - Go to **console.anthropic.com**, sign up (this is separate from your Claude Max subscription).
   - **Billing → add ~$5** of credit. That's plenty for a 30-student class.
   - **API Keys → Create Key**, and copy it.

2. **Add the key to the app:**
   - In this folder, find the file **`.env.example`**. Make a copy and rename the copy to **`.env`**.
   - Open `.env` in Notepad, paste your key after `ANTHROPIC_API_KEY=`, and save.

3. **Install the app** (one time). Open PowerShell *in this folder* and run:
   ```
   npm install
   ```

---

## Running it

In PowerShell, in this folder:
```
npm start
```
Then open **http://localhost:3000** in Chrome or Edge.

- **Instructor side:** http://localhost:3000  → Create an assignment, copy the student link.
- **Student side:** the link looks like `http://localhost:3000/student.html?a=...`
  Open it in another tab to play "student" and test the full conversation.

To stop the app, click in the PowerShell window and press **Ctrl + C**.

---

## What's where

- Assignments, transcripts, and feedback are saved in the **`data`** folder (plain files — yours).
- Recorded videos are in **`data/videos`**. To free space, open a submission, download the video to an
  external drive, then click **Delete submission + video**. (Transcripts stay either way.)

## Notes
- **Privacy:** while piloting, everything stays on your computer. Nothing is uploaded anywhere except the
  reading + answers that go to Anthropic to run the conversation. Student data isn't used to train models.
- Chrome or Edge required for the live voice-to-text. Other browsers can still type answers.
- This is Stage A (local pilot). Stage B = a private website your students can reach, with the
  video-retention/offload workflow and FERPA-appropriate storage.
