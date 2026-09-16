# Football AI Lab Telegram relay

Cloudflare Worker transport with protected secret bindings. Production publishes
from main through Cloudflare Builds. Non-production branches upload versions.

Routes: GET /health, POST /api/telegram/send, POST /api/telegram/edit.

Required encrypted Worker secrets: RELAY_SHARED_SECRET and TELEGRAM_BOT_TOKEN.
Missing configuration fails closed. There is no embedded-key verifier and no
caller-supplied bot-token fallback. Secret values must never be committed.

Requests use the existing form contract; only allowlisted Telegram fields are
forwarded. Body streaming is limited to 64 KiB. A failed/uncertain upstream request
is not retried automatically. This transport does not provide durable request
deduplication; the calling system must provide its own delivery journal.

Offline tests: `node --test test/index.test.mjs`. All upstream requests are mocked.
Do not send real Telegram messages as deployment probes.

Deploy only after both protected bindings are configured. Preview URLs are
disabled. Never roll back to an exposed credential or reintroduce a key fallback.
