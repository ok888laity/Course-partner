# Tingke Pocket

Build a small, dependency-free mobile lecture capture app and a Site-hosted ChatGPT MCP plugin.

- No model API key or private ChatGPT endpoint. The current ChatGPT conversation does image understanding and notes using MCP tools. Do not claim to control official Voice/Record or automatically transcribe raw audio.
- Optional browser/device SpeechRecognition must be feature-detected, user-started, labeled as device dictation, and never required to save audio/photos. Import/paste transcript is supported.
- Target iPhone foreground use; no guarantee of background/5-hour reliability without real-device tests. Do not fabricate recordings, transcripts, or ready statuses.
- Photos carry recording elapsed time at shutter. Use a monotonic recording clock, excluding explicit pauses. Audio and photos persist locally before upload; upload is idempotent. Do not clear local queued data until server acknowledgment.
- No runtime dependency, external font, CDN, analytics, or service worker caching user data. Keep assets small. Use textContent for user text.
- All hosted user data must be scoped to the platform-authenticated Site user ID. No anonymous private API access, no secrets in source or browser code. Do not implement a public sharing endpoint.
- Agent ownership: UI agent owns web/index.html, web/app.js, web/style.css. Recorder agent owns web/recorder.js and tests/recorder.test.mjs. Root owns worker/, web/bridge.js, web/store.js, scripts/, README and packaging.
- APIs in API-CONTRACT.md. Communicate contract changes to root before edits outside ownership. Do not touch .openai/hosting.json or deploy.
