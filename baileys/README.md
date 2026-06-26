# WhatsApp Group Auto-Forwarder (Baileys)

Watches the WhatsApp groups you choose and **natively forwards** every new
message to another number. Both numbers are assumed to be your own.

Unlike the browser-extension approach (see `../`), this talks to WhatsApp's
**multi-device protocol directly** via [Baileys](https://github.com/WhiskeySockets/Baileys).
It does **not** depend on the WhatsApp Web UI or its internal modules, so it
doesn't break when WhatsApp reshuffles the web bundle — which is exactly what
broke the extension.

## Trade-offs vs the extension

- ✅ Robust — immune to WhatsApp Web UI/internal changes.
- ✅ Runs headless in the background; no browser tab to keep open.
- ✅ Native forwarding (keeps media + "Forwarded" semantics).
- ⚠️ Links as a **separate device** (uses one of your 4 linked-device slots).
- ⚠️ One-time QR link, then it stays paired (auth saved in `./auth`).

## Setup

```bash
cd baileys
npm install          # already done if you saw "added 73 packages"
```

## 1. Link your account & list groups

```bash
npm run groups
```

- Scan the QR shown in the terminal:
  **WhatsApp → Settings → Linked devices → Link a device**.
- It prints every group with its JID, e.g.:
  ```
  120363012345678901@g.us   Family
  120363098765432109@g.us   Work crew
  ```
- Auth is saved in `./auth`, so you only scan once.

## 2. Configure `config.json`

```json
{
  "targetNumber": "15551234567",
  "watchedGroups": ["120363012345678901@g.us"],
  "skipFromMe": true,
  "minDelayMs": 2000
}
```

| Field | Meaning |
|-------|---------|
| `targetNumber` | Number to forward **to**, full international form, digits only. |
| `watchedGroups` | Array of group JIDs (from `npm run groups`) to forward **from**. |
| `skipFromMe` | `true` = don't forward messages you sent in the group. |
| `minDelayMs` | Minimum spacing between forwards (anti-spam throttle). |

`config.json` is **hot-reloaded** — edit it while running and changes apply
within ~1s, no restart needed.

## 3. Run the forwarder

```bash
npm start
```

New messages in the watched groups are forwarded to `targetNumber`. Each
forward is logged:

```
→ forwarded imageMessage from 120363012345678901@g.us → 15551234567
```

Leave it running (e.g. in a `tmux`/`screen` session, or under `pm2`/`launchd`
for always-on). It auto-reconnects if the connection drops.

## Notes & safety

- Only **live** messages are forwarded (`messages.upsert` type `notify`);
  history sync on connect is ignored, so it won't replay old messages.
- System/control messages, reactions, and poll updates are skipped.
- Even between your own numbers, keep `minDelayMs` sane — WhatsApp bans on
  **behaviour** (volume/velocity), not on how you connect.
- This is unofficial automation and violates WhatsApp's Terms of Service. The
  only ToS-compliant route for programmatic messaging is the WhatsApp
  Business / Cloud API.

## Files

| File | Purpose |
|------|---------|
| `socket.js` | Connection lifecycle: QR link, auth persistence, auto-reconnect. |
| `index.js` | Watches groups, throttled queue, native forward. |
| `list-groups.js` | Prints group JIDs for `config.json`. |
| `config.json` | Your settings (hot-reloaded). |
| `auth/` | Saved login (git-ignored — keep private, it *is* your session). |
