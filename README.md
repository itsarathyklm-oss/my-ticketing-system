# Sarathy IT Helpdesk — Ticketing System

A self-hosted IT helpdesk for **Sarathy Pvt Ltd**. Employees submit tickets for IT problems (hardware, software, network, printers); IT staff work and resolve them; admins escalate and reassign. Public submission needs no login. Built as a single Express app with a MySQL database, Cloudinary for file storage, and email alerts.

> **Note on file layout:** nearly all application code lives in one file, `server.js` (~4,150 lines). It defines the database models' usage, every route, and embeds the HTML/CSS/JS for all pages as template strings. The database schema itself is in `db.js`. Read the two together.

---

## Table of contents

- [What it does](#what-it-does)
- [The three roles](#the-three-roles)
- [Data flow](#data-flow)
- [Setup](#setup)
- [Environment variables](#environment-variables)
- [Project structure](#project-structure)
- [Database](#database)
- [File uploads](#file-uploads)
- [Error logging](#error-logging)
- [Security notes](#security-notes)

---

## What it does

There are three surfaces:

1. **Public ticket page (`/`)** — any employee, no login, submits a ticket: name, designation, mobile number, branch, category (Hardware/Software/Network/Printer/Other), priority, description, optional screenshot. A ticket number is issued (`#0001` for branches without a code, or `#SAC70/0001` for branches with one). The mobile number is the public "receipt" — used later to check status.

2. **Public status lookup (`/tickets/lookup?mobile=...`)** — the submitter checks their own ticket status by mobile number, rate-limited and returning only non-sensitive fields (title, branch, priority, status, dates, assignee name). No login.

3. **Admin dashboard (`/admin`)** — the working console for staff and admins. Ticket list with filters, SLA countdown/breach badges, escalation, resolution checklist, internal work notes with attachments, notifications bell, Excel report export, audit log, region/branch/staff management, and an internal inbox.

**Auto-assignment:** when a ticket is created for a branch that has staff, it is assigned automatically by round-robin (`assignSeq` cursor on the branch), so staff rotate strictly 1,2,3,1,2,3 without races. If the branch has no staff, it lands unassigned for an admin to allocate.

**SLA:** every ticket gets a priority-based SLA deadline (calculated from `priority` and `createdAt`). The dashboard shows live countdowns and flags breached tickets. This is display-only; it does not auto-close anything.

---

## The three roles

Access is enforced by three middleware functions in `server.js`: `checkUserLogin`, `checkAdminLogin`, `checkSuperAdminLogin`. Sessions revalidate region admins against the database on every request, so disabling a region admin in the DB logs them out on their next call.

| Role | Who | Sees | Can do |
|---|---|---|---|
| **Staff** | `staff` table rows | Only tickets assigned to them or escalated by them | Work notes, checklist, escalate (with reason), resolve (checklist must be complete), change own password, inbox |
| **Region Admin** | `region_admins` table rows | Only tickets whose branch is in their region | Everything staff can do, plus: reallocate escalated tickets to staff in their region, resolve without the checklist, manage branches/staff in their region, reply to inbox, region-scoped reports |
| **Super Admin** | the `Admin` account from env vars (`ADMIN_USERNAME`/`ADMIN_PASSWORD`) — **not** a database row | All tickets, all regions | Everything, plus: create/rename/delete regions, create/edit/delete region admins, view the audit log, manage all branches and staff |

A ticket is *escalated* when a staff member cannot resolve it (typically the assignee is on leave). Escalation sets `escalated=true` and reassigns the ticket to the **region admin** for the ticket's branch (falling back to the Super Admin if no region admin is enabled for that region). While escalated and unallocated to staff, the ticket shows a "Needs admin action required" banner.

---

## Data flow

```
Employee (public /)
   │  submits ticket (+ optional screenshot → Cloudinary)
   ▼
Ticket created ──► auto-assigned round-robin to branch staff (if any)
   │               SLA deadline set from priority
   │               Notification created for assignee  ──►  bell + sound
   │               Assignment email sent (Nodemailer)
   ▼
Staff (/admin) works it
   │  • Internal Work Notes (text + attachment)
   │  • Resolution Checklist (6 items; must be complete before staff can resolve)
   │
   ├─► Resolve ──► status=Resolved, resolvedAt/resolvedBy set
   │
   └─► Escalate (reason required) ──► assignedTo = region admin for the branch
                                          │
                                          ▼
                                   Region Admin
                                      │ Reallocate to staff in region
                                      │ Resolve (checklist bypass allowed)
                                      ▼
                                   Resolved

Cross-cutting, on every relevant action:
  • AuditLog row written (escalations, reallocations, resolves, region/branch/staff changes)
  • Notification row created for the affected user
  • Errors logged to ./logs/error.log (see Error logging)
```

Key relationships: a **Ticket** belongs to a **Branch**, which belongs to a **Region**. A **Staff** member is assigned to branches via **StaffBranchAssignment** (one row per pairing). A **RegionAdmin** owns one region. **TicketComment** and **TicketChecklist** are child tables of Ticket. **Notification**, **AuditLog**, and **InboxMessage** are standalone.

---

## Setup

**Prerequisites:** Node.js 18+, MySQL 8+ (or MariaDB), a Cloudinary account (for screenshots), and SMTP credentials (Gmail app password works).

```bash
# 1. Install dependencies (lockfile is committed)
npm ci

# 2. Create your environment file
cp .env.example .env      # then fill in every value — see the table below

# 3. Create the database, then let the app build its schema on first boot
mysql -u root -p -e "CREATE DATABASE helpdesk CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
npm run dev
```

There is **no manual migration step**. On boot the app runs `sequelize.sync()` (creates any missing tables) followed by `ensureBranchCodeColumns()`, which inspects `information_schema` and issues `ALTER TABLE` only for columns that are missing. This is idempotent and safe to run on every start, local and production.

**Run:**
```bash
npm run dev        # node start-preview.js — listens on 0.0.0.0:$PORT (default 3000)
```

Then open `http://localhost:3000/` (public submission) and `http://localhost:3000/admin` (dashboard).

**Deployment:** designed for Render or any Node host. `app.set('trust proxy', 1)` is already set so secure cookies and `req.ip` work behind the reverse proxy. Note the SMTP IPv4 workaround at the top of `server.js` (`dns.setDefaultResultOrder('ipv4first')`) — Render's outbound network does not reliably support IPv6.

---

## Environment variables

All secrets come from the environment. **Never commit real values** — `.env` is gitignored. The app fails loudly where it matters (e.g. no `SESSION_SECRET` logs a warning and falls back to a random key that invalidates sessions on restart).

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | No (default `3000`) | HTTP port |
| `NODE_ENV` | Recommended | `production` enables the `secure` cookie flag |
| `SESSION_SECRET` | **Yes (prod)** | Signs session cookies. Random fallback if unset (sessions reset on restart) |
| `ADMIN_USERNAME` | **Yes** | Super Admin login name (the env-var account, not a DB row) |
| `ADMIN_PASSWORD` | **Yes** | Super Admin login password |
| `MYSQL_HOST` | Yes | Database host |
| `MYSQL_PORT` | No (default `3306`) | Database port |
| `MYSQL_DATABASE` | Yes | Database name |
| `MYSQL_USER` | Yes | Database user |
| `MYSQL_PASSWORD` | **Yes** | Database password |
| `MYSQL_SSL` | Managed DBs | `1` forces TLS (auto-enabled for non-localhost hosts) |
| `MYSQL_CA_FILE` | Managed DBs | Path to CA cert for strict TLS verification |
| `CLOUDINARY_CLOUD_NAME` | Yes | Cloudinary account |
| `CLOUDINARY_API_KEY` | Yes | Cloudinary credentials |
| `CLOUDINARY_API_SECRET` | Yes | Cloudinary credentials |
| `EMAIL_USER` | Optional | SMTP username (e.g. Gmail address). App boots without it, logs a mailer warning |
| `EMAIL_PASS` | Optional | SMTP password (Gmail app password) |
| `LOG_DIR` | No (default `./logs`) | Where the error log is written |

---

## Project structure

```
server.js          The entire application: routes, auth, HTML/CSS/JS template strings
db.js              Sequelize connection + all 12 model definitions + startup migration
start-preview.js   Entry point: sets PORT=3000 and requires server.js
admin_features.js  Client-side extras injected into the dashboard <script> tag
checklist.js       Client-side resolution-checklist UI (loaded by admin_features.js)
service-worker.js  PWA service worker: caches static assets (images, manifest), network-first for JS/CSS
manifest.json      PWA manifest
schema.sql         Reference copy of the schema (the app does not run this file)
uploads/           Local upload fallback (gitignored)
logs/              Runtime error log (gitignored — see Error logging)
```

Static assets served from the project root: `logo.png`, `background.png`, `icon-512.png`, `loading.gif`, `notification.mp3`, `intro-video.mp4` (the login splash animation). There is an explicit **static-file allowlist** in `server.js` — arbitrary files in the repo (including `schema.sql` and `.env`) are not downloadable.

---

## Database

Twelve Sequelize models (see `db.js` for exact columns):

| Table | Purpose |
|---|---|
| `regions` | Regions grouping branches |
| `branches` | Branches; carries `code` (for `#SAC70/0001` numbering) and the `ticket_seq`/`assign_seq` counters |
| `staff` | IT staff accounts (bcrypt-hashed passwords; legacy plaintext is lazily upgraded on successful login) |
| `staff_branch_assignments` | Which branches each staff member covers |
| `region_admins` | Region admin accounts (`enabled` flag gates login and escalation routing) |
| `tickets` | The tickets themselves |
| `ticket_comments` | Internal work notes (one row per note, with optional attachment) |
| `ticket_checklists` | Resolution checklist state (one row per ticket per checklist item) |
| `audit_logs` | Trail of admin/staff actions (auto-purged after 30 days on boot) |
| `notifications` | Per-user bell notifications |
| `inbox_messages` | Internal staff↔admin messaging |

Ticket numbering: `display_number` is stamped at creation (`SAC70/0001`) and **never rewritten**, so renaming a branch or changing its code never alters numbers already issued. Branches without a code fall back to the legacy zero-padded id (`#0001`).

---

## File uploads

Screenshots and note attachments go to **Cloudinary** (`helpdesk_screenshots` folder) via `multer-storage-cloudinary`. Upload security is an **allowlist**, not a blocklist — anything not explicitly allowed is rejected regardless of a disguised extension:

- **Extensions:** `.jpg .jpeg .png .webp .gif .pdf`
- **MIME types:** `image/jpeg image/png image/webp image/gif application/pdf`
- Both the extension **and** the browser-reported MIME are checked (either alone can be spoofed).
- Max size **5 MB** per file.

---

## Error logging

Errors are logged to **`./logs/error.log`** (override the directory with `LOG_DIR`). This is the answer to "a user hit an error at 3am — can I find out?"

- **What gets logged:** every route-level `console.error(...)`, plus any error caught by the **global Express error handler** (the 4-arg `app.use((err, req, res, next) => ...)` registered after all routes), plus **process-level** `unhandledRejection` and `uncaughtException` (which log, then exit so a supervisor can restart a clean process).
- **Format:** one JSON object per line — `ts` (ISO timestamp), `level` (`error`/`warn`), `message`, **full `stack`**, and `context` (`method`, `url`, `user`). Previously the app logged only `err.message` and threw the stack away.
- **Redaction:** context keys matching password/secret/token/authorization/cookie/api-key are dropped before writing, so a credential never lands in the log.
- **Rotation:** at 5 MB the file is renamed to `error.log.1` (one backup kept) — the log can never grow without bound.
- **Console is unchanged** — the shim only *adds* a file write, so existing behaviour and any host log streaming keep working.

Read it with `tail -f logs/error.log`. On Render's free tier the disk is ephemeral, so logs reset on redeploy — for permanence use a paid disk or ship the file to an external store.

---

## Security notes

- **Auth:** bcrypt password hashing (with lazy upgrade of legacy plaintext rows on successful login), session cookie `httpOnly` + `sameSite=lax` + `secure` in production, 4-hour inactivity timeout.
- **Rate limiting:** login (8/IP/15 min), public ticket creation, and status lookup are all rate-limited per IP.
- **XSS:** user-supplied text is escaped with `escHtml()` before rendering.
- **Access control:** region admins are scoped to their region on every read and write; super-admin-only routes are guarded separately. *(An audit of this codebase found known gaps — most notably that the comment endpoint does not verify ticket ownership — see the audit report before relying on this for sensitive data.)*
- **Static files:** explicit allowlist, so repo files are not publicly downloadable.

---

## Known limitations / roadmap

The following came out of a recent code audit and are **not yet fixed** — documented here so a new maintainer inherits the full picture:

1. **Comment endpoint lacks an ownership check** (`POST /tickets/:id/comment`) — any logged-in staff can comment on any ticket by ID. *Highest priority.*
2. **`/tickets/lookup` returns `assignedTo`** to unauthenticated callers — reveals which employee a ticket is assigned to.
3. **Checklist routes are not region-scoped** — a region admin can touch checklists outside their region (inconsistent with resolve).
4. **`escHtml()` is defined 3×** (byte-identical) — should be a single shared module.
5. **No automated tests.** `npm test` is the default "no test specified" stub.
