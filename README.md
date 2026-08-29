# Football AI Lab Telegram relay

Cloudflare Worker transport between the Yandex Cloud live monitor and Telegram.

Routes:

- `GET /health`
- `POST /api/telegram/send`
- `POST /api/telegram/edit`

Required Worker secrets:

- `RELAY_SHARED_SECRET`
- `TELEGRAM_BOT_TOKEN`

The relay accepts the current Yandex form contract, authenticates it, strips
relay-only fields, and forwards only the Telegram request payload.
