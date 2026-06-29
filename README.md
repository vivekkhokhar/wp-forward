# WhatsApp Forwarder — EC2 Deployment

A personal WhatsApp message forwarder: it watches selected **groups and contacts**
and natively forwards their messages to other numbers. Runs 24/7 on AWS EC2 using
[Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp's multi-device protocol).

Each forward arrives at its target with a bold **source-name header** so you can tell
where it came from, and routing is **multi-target** (different sources → different numbers).

It also **archives every message** (incoming + outgoing, all chats) to DynamoDB, with
media in S3 — browsable through a small local web viewer.

---

## Why Baileys (not a browser extension)

An earlier attempt used a Chrome extension driving WhatsApp Web's internals (`wa-js`).
It broke immediately because WhatsApp changes its web bundle frequently. Baileys speaks
the multi-device **protocol** directly — it never touches the web UI, so it's robust to
those changes. Trade-off: it links as a separate device (one of your 4 slots) and runs as
a background process.

---

## Repo layout

```
whatsapp-forward/
├── README.md              # this file — deployment + operations
├── connect.sh             # SSH into the instance (no IP to remember)
├── deploy.sh              # push local changes to the instance + restart pm2
├── instance.env           # instance connection vars   (git-ignored)
├── instance.env.example   # template for the above
├── baileys/               # the forwarder (runs on EC2)
│   ├── index.js           # the router: watch chats, forward matches
│   ├── socket.js          # connection lifecycle (QR link, auth, auto-reconnect)
│   ├── store.js           # archive every message → DynamoDB (+ media → S3)
│   ├── list-groups.js     # print group JIDs for config
│   ├── config.json        # routing + persist config    (git-ignored — phone numbers)
│   ├── config.example.json
│   ├── package.json
│   ├── auth/              # WhatsApp session             (git-ignored — THIS IS YOUR LOGIN)
│   └── README.md          # app-level notes
└── viewer/                # local web UI to browse the archive (runs on your machine)
    ├── server.js          # Express: DynamoDB reads + S3 presign (uses your AWS profile)
    ├── public/            # two-pane chat UI
    └── README.md
```

---

## AWS deployment

Provisioned with the AWS CLI (profile `cli_user`, account `315286220307`) in
**ap-south-1 (Mumbai)**.

| Resource | Value |
|---|---|
| Instance | `i-0967fc318a9710d76` — **t4g.small** (ARM/Graviton), Amazon Linux 2023 arm64 |
| AMI | `ami-0fd54db84e5da63fc` |
| Public IP | `13.206.79.15` — ⚠ **changes if the instance is stopped/started** (source of truth: `instance.env`) |
| Security group | `sg-049d6f84b10eb24eb` — inbound SSH (22) from your IP only |
| Key pair | `wa-forward` → `~/.ssh/wa-forward.pem` (ed25519) |
| VPC | `vpc-8ad083e2` (default) |
| Swap | 1 GB swapfile (`/swapfile`) for npm/Node headroom |
| DynamoDB table | `wa-messages` — PK `chatJid`, SK `sk` (`ts#id`), on-demand |
| S3 bucket | `wa-messages-media-315286220307` — private, all public access blocked |
| IAM role / instance profile | `wa-forward-role` / `wa-forward-profile` — least-priv `dynamodb:PutItem` + `s3:PutObject` + `AmazonSSMManagedInstanceCore`; attached to the instance |

### Instance bootstrap (cloud-init)
On first boot the user-data installed:
- 1 GB swapfile (persisted in `/etc/fstab`)
- Node.js 20 (via NodeSource) + git
- pm2 (global)

Verified versions: Node `v20.20.2`, pm2 `7.0.1`.

---

## Application & configuration

The app lives at `~/wa-forward` on the instance and runs under pm2 as process **`wa-forward`**.

Routing is driven entirely by `baileys/config.json` (schema in `config.example.json`):

| Field | Meaning |
|---|---|
| `rules[]` | Each rule = one `target` + its sources. A message is forwarded to **every** rule it matches. |
| `rules[].target` | Destination number (country code + number, digits only). |
| `rules[].groups[]` | Group JIDs (`…@g.us`) to forward from. Get them with `npm run groups`. |
| `rules[].contacts[]` | Individual numbers to forward from. |
| `rules[].forwardAllDMs` | `true` = forward **every** DM (not just listed contacts). DM-only; doesn't affect groups. |
| `skipFromMe` | `true` = don't forward messages you send. |
| `minDelayMs` | Throttle between forwards (anti-spam). |
| `prefixGroupName` | Send a bold `📨 *Source Name*` header before each forward. |
| `verbose` | Log every received message and the routing decision. |
| `chatLabels` | Override the header label for a specific JID. |
| `persist` | Message-archive settings — see **Message archive** below. |

Routing is **hot-reloaded** — edit `config.json` on the instance and changes apply within ~1s.
(The recommended flow is to edit locally and `./deploy.sh`.)

Current routing (see `config.json` for exact numbers): two targets — *Vivek - Android* and
*Kamal - Android* — fed by their respective groups/contacts.

---

## Message archive (DynamoDB + S3)

**Independent of forwarding.** `store.js` persists **every** message the device sees —
incoming *and* outgoing, across **all** chats (not just watched ones) — to DynamoDB, with
media streamed to S3. It's async, concurrency-limited, and fully wrapped: an AWS failure
is logged and swallowed, so it can **never** block or crash the forwarder.

**`config.json → persist` block:**
```json
"persist": {
  "enabled": true,
  "tableName": "wa-messages",
  "region": "ap-south-1",
  "mediaBucket": "wa-messages-media-315286220307",
  "mediaScope": "all",        // "all" = download media from every chat; "watched" = only rule chats
  "verbose": false             // log each archived message
}
```

**Table item** (PK `chatJid`, SK `sk` = `${timestamp}#${messageId}` → chronological + idempotent dedup):

| Attr | Notes |
|---|---|
| `chatJid`, `sk`, `messageId` | keys + id |
| `direction` / `fromMe` | `in` / `out` |
| `isGroup`, `chatName` | display name — group subject (groups) / contact pushName or phone (DMs) |
| `sender`, `senderName` | participant + pushName |
| `type`, `text` | content type + body/caption |
| `emoji`, `reactionTo` | for reactions: the emoji + id of the message reacted to |
| `timestamp`, `isoTime` | epoch + ISO |
| `mediaKey`, `mediaMime`, `mediaSize` | S3 object `chatJid/messageId.<ext>` (or `mediaError`) |

**Auth:** the EC2 instance assumes `wa-forward-role` (instance profile) — the SDK picks the
credentials from instance metadata automatically. No keys in code or config.

**Notes:**
- "Every message" is literal — reactions (with the **emoji** + the **`reactionTo`** target
  message id), live-location, etc. are stored too (only pure protocol/key-distribution
  messages are skipped).
- `mediaScope: "all"` means S3 grows with every chat's media. Flip to `"watched"` to store
  media only for the chats in your rules (text+metadata is still saved for everything).
- Idempotent on re-delivery (same `sk`), so `append`/`notify` duplicates collapse.

---

## Viewer (local UI)

A small Express app in `viewer/` to browse the archive on your machine. It reads DynamoDB
and presigns the private S3 media using your local AWS profile (read-only).

```bash
cd viewer
npm install
npm start            # → http://localhost:5173
```

Two-pane WhatsApp-style UI: chat list (most-recent first, real names) → messages, with
images/video/audio rendered inline via 1-hour presigned URLs. Config via env vars
(`AWS_PROFILE`, `WA_REGION`, `WA_TABLE`, `WA_BUCKET`, `PORT`) — defaults match this stack.
The chat list uses a table **Scan** (fine at personal volume; add a GSI if it grows large).
See `viewer/README.md`.

---

## Day-to-day operations

From this project folder:

```bash
./connect.sh                          # open a shell on the instance
./connect.sh pm2 logs wa-forward      # live logs
./connect.sh pm2 status               # health (uptime, restarts, mem)

# change routing: edit baileys/config.json locally, then:
./deploy.sh                           # rsync code + npm install + pm2 restart
```

pm2 commands (on the instance):

```bash
pm2 restart wa-forward
pm2 stop wa-forward
pm2 logs wa-forward --lines 100 --nostream
```

**Persistence:** `pm2 save` + a systemd startup hook are configured, so the forwarder
**auto-starts on reboot and restarts on crash**.

---

## Linking / re-linking WhatsApp

The session is stored in `~/wa-forward/auth/`. To (re)link:

```bash
./connect.sh
cd ~/wa-forward
pm2 stop wa-forward
node index.js          # scan QR: WhatsApp → Settings → Linked devices → Link a device
# wait for "✓ Connected to WhatsApp", then Ctrl+C
pm2 start wa-forward
```

- Uses one of your 4 linked-device slots.
- Run **only one** copy of the session at a time (the laptop has been unlinked).

---

## Logs

- **Files:** `~/.pm2/logs/wa-forward-out.log` (activity) and `wa-forward-error.log` (errors).
- **Rotation:** `pm2-logrotate` is installed — rotate at **10 MB or daily**, keep **7**
  compressed archives, prune older. Disk stays bounded.
- **Log markers:**
  - `✦ match` — message matched a rule (about to forward)
  - `→ forwarded` — sent to a target
  - `·  <reason>` — received but not forwarded (e.g. `no rule match`, `skip (you sent it)`)

---

## Cost & billing

- t4g.small runs under the **EC2 T4g free trial** (750 free t4g.small hrs/month) →
  effectively **free compute through Dec 31, 2026** (you pay only ~$1/mo for the EBS disk).
- **After Dec 31, 2026**, t4g.small reverts to on-demand ≈ **~$12/mo**.
- **Plan:** buy a 1-year **Reserved Instance / Savings Plan** for t4g.small in ap-south-1
  before the trial ends.
- A one-time reminder routine (`trig_019xFS7gBRffJRf8bFRWdgCB`) fires **Dec 15, 2026** to
  surface current RI/Savings-Plan pricing.

---

## Security

- **`auth/` is your WhatsApp login** — never commit or share it. (git-ignored)
- The instance uses an **IAM role** (`wa-forward-role`), not access keys — least-privilege,
  write-only to the table + bucket. The local viewer uses your `cli_user` profile, read-only.
- SSH is locked to your IP in the security group; key-based auth only.
- `instance.env` (server access) and `config.json` (phone numbers) are git-ignored;
  `*.example` files are the safe templates.
- Nothing sensitive is tracked in git (verified with `git check-ignore` / `git ls-files`).

---

## Troubleshooting

**Can't SSH (timeout):** your home IP probably changed. Re-authorize it (revoke the old CIDR too):
```bash
MYIP=$(curl -s https://checkip.amazonaws.com)
aws ec2 authorize-security-group-ingress --group-id sg-049d6f84b10eb24eb \
  --protocol tcp --port 22 --cidr ${MYIP}/32 --profile cli_user --region ap-south-1
```
Or skip IP whitelisting entirely — the instance has the SSM agent + role, so:
```bash
aws ssm start-session --target i-0967fc318a9710d76 --profile cli_user --region ap-south-1
```

**Public IP changed (after a stop/start):** fetch the new one and update `instance.env`:
```bash
aws ec2 describe-instances --instance-ids i-0967fc318a9710d76 \
  --profile cli_user --region ap-south-1 \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text
```
(To avoid this entirely, attach an Elastic IP to pin the address.)

**Not forwarding:** `./connect.sh pm2 logs wa-forward` and look for `Connection closed` or
`Logged out`. If logged out, re-link (above).

**Session dead / logged out:** delete `~/wa-forward/auth` on the instance and re-link.

---

## Rebuild from scratch (summary)

Profile `cli_user`, region `ap-south-1`:
1. Create key pair `wa-forward` (ed25519) → save `~/.ssh/wa-forward.pem` (chmod 400).
2. Create security group `wa-forward-sg`; allow SSH (22) from your IP only.
3. `run-instances`: t4g.small, AL2023 arm64 AMI, with user-data (swapfile + Node 20 + pm2),
   IMDSv2 required, tag `Name=wa-forward`.
4. `rsync` the `baileys/` folder up (exclude `node_modules`, `auth`), then `npm install`.
5. `node index.js` → scan QR to link.
6. `pm2 start index.js --name wa-forward && pm2 save && pm2 startup` (run the printed sudo cmd).
7. `pm2 install pm2-logrotate` and set `max_size 10M`, `retain 7`, `compress true`.
8. **Archive:** create DynamoDB table `wa-messages` (PK `chatJid`, SK `sk`, on-demand) and a
   private S3 bucket; create IAM role `wa-forward-role` (`dynamodb:PutItem` + `s3:PutObject` +
   `AmazonSSMManagedInstanceCore`), put it in instance profile `wa-forward-profile`, and
   `associate-iam-instance-profile` to the instance.
