# Nexus

A private chat for your own notes, as a web app for the phone. It reads a private GitHub repo of Markdown notes and photos, answers with Google's Gemini API, and saves new information to an inbox file in that repo.

Everything runs in the browser. This site holds no data: keys stay in the browser storage of the device, and notes are read from your own repo when you ask.

## Setup
1. Open the site in Safari on the phone → Share → **Add to Home Screen**, then open it from the icon.
2. Settings:
   - **Gemini API key** from aistudio.google.com.
   - **GitHub token:** a fine-grained token limited to the one notes repo, with Contents: Read and write.
   - **Repository:** `owner/name`.
3. Test connection, then Save.

The model reads `AGENTS.md` and a few other files at the start of each answer (configurable), then opens what it needs. New information goes to `inbox/phone.md`.

**Privacy:** on Gemini's free tier, Google may use prompts and responses to improve its products, and human reviewers may read them. A paid API project avoids that.

## Files
- `js/app.js`: chat loop, tools and screen
- `js/github.js`, `js/gemini.js`: the two APIs
- `js/prompt.js`: the model's instructions and tools
- `js/markdown.js`: renders replies (all HTML is escaped)
- `sw.js`: offline copy of the app's own files
