# WA Archive Viewer (local)

A small local web UI to browse the WhatsApp messages archived in DynamoDB
(`wa-messages`) with media served from the private S3 bucket via presigned URLs.

Runs entirely on your machine using your local AWS profile — nothing is exposed.

## Run

```bash
cd viewer
npm install
npm start          # → http://localhost:5173
```

Open **http://localhost:5173**. Left pane = chats (most-recent first), click one to
see its messages on the right. Images/video/audio render inline (via short-lived
presigned URLs); documents show as download links.

## Configuration (env vars, all optional)

| Var | Default |
|-----|---------|
| `AWS_PROFILE` | `cli_user` |
| `WA_REGION` | `ap-south-1` |
| `WA_TABLE` | `wa-messages` |
| `WA_BUCKET` | `wa-messages-media-315286220307` |
| `PORT` | `5173` |

It reads credentials from your `~/.aws` profile (same one used to provision the stack).
Read-only: it only issues DynamoDB `Scan`/`Query` and presigns S3 `GetObject`.

## How it works

- **`GET /api/chats`** — scans the table once and aggregates by `chatJid` (name, last
  message, count). Fine at personal volume; if the archive grows very large, add a GSI
  and switch this to a query.
- **`GET /api/messages?chat=<jid>`** — `Query` on the chat partition, chronological.
- **`GET /api/media?key=<s3key>`** — returns a 1-hour presigned URL for the object.

## Notes

- The chat list uses a full table **Scan** — cheap now, but O(table size). Watch it if
  the archive gets large.
- Media URLs are presigned and expire in 1 hour (generated on demand per view).
