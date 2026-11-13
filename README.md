# Nexus

A full-featured help desk (Freshdesk-style) built with **React**, **Node.js/Express** and **Convex** (database + file storage).

It deploys as **one service**: the Express server serves both the REST API (`/api`) and the built React app on the same port.

```
support-application/
├── Dockerfile  Builds the single deployable service (React build + API)
├── backend/    Node.js + Express REST API, Convex schema/functions (backend/convex), seed data
└── frontend/   React (Vite) agent dashboard + customer portal
```

## Data: Convex

All tables live in the Convex **Nexus** project (team `rakeshwfg`, deployment `curious-ram-94`).

- `backend/convex/tables.js` – table/column metadata (generated from the legacy Postgres schema; source of truth now)
- `backend/convex/schema.js` – Convex schema + indexes built from that metadata
- `backend/convex/db.js` – generic data functions (unique constraints, cascading deletes, numeric ids) called only by the API server
- `backend/convex/files.js` – attachments and images in Convex file storage (served at `/uploads/<name>`)
- `backend/src/db/index.js` – the data API used by every route

The Convex functions require a shared secret (`NEXUS_SERVER_SECRET`) that is set both on the Convex deployment and in the server's environment, so they cannot be called from a browser.

## Quick start

Prerequisites: Node 18+ and access to the Convex Nexus project (`npx convex login`).

```bash
npm run install:all
cp backend/.env.example backend/.env   # set NEXUS_SERVER_SECRET (same value as on the Convex deployment)

# Push schema + functions to the Nexus deployment (backend/.env.local pins CONVEX_DEPLOYMENT=dev:curious-ram-94)
npm run convex:push

# Optional: demo data (only if Convex is empty) – or `npm run db:reset` to wipe and reseed
npm run db:seed

# Single service: build the React app, then serve app + API on http://localhost:4000
npm run build
npm start
```

For development with hot reload run `npm run dev:backend` and `npm run dev:frontend` (Vite on http://localhost:5173 proxies `/api` and `/uploads` to the API).

### Deploying

Deploy one service from the repo root – either the `Dockerfile`, or a Node host with build command `npm run build` and start command `npm start`. Set these environment variables: `CONVEX_URL`, `NEXUS_SERVER_SECRET`, `JWT_SECRET` (and optionally `PORT`, SMTP settings). Run `npm run convex:push` whenever `backend/convex/` changes.

### Migrating existing Postgres data

`backend/scripts/import-from-postgres.js` copies every table (keeping ids) and `backend/uploads/` files into Convex:

```bash
cd backend && PG_URL=postgres://postgres:1234@127.0.0.1:5432/supportdesk node scripts/import-from-postgres.js --wipe
```

### Demo accounts (password: `password123`)

| Role                | Email                    |
| ------------------- | ------------------------ |
| Admin agent         | admin@supportdesk.local  |
| Agent               | priya@supportdesk.local  |
| Customer (portal)   | customer@acme.com        |

See [docs/FEATURE_PARITY.md](docs/FEATURE_PARITY.md) for the full feature checklist and what still needs an outside provider.

## Features

**Tickets**
- Inbox with views (unresolved, my open, unassigned, overdue, due today, watching, spam, trash), filters, sorting, search, pagination and CSV export
- Saved views (private or shared with all agents)
- Create on behalf of a contact (auto-creates contacts, links companies by email domain)
- Public replies, private notes, forwards, attachments, canned responses with placeholders, agent signature
- Status / priority / type / source / group / agent / tags / due date / custom fields
- Bulk actions (assign, status, priority, group, spam, delete, restore)
- Merge tickets, watch tickets, time tracking, full activity log
- Round-robin auto-assignment inside groups

**SLA**
- Multiple SLA policies with conditions (priority, type, source, group, company) and per-priority response/resolution targets
- Due dates computed on create and recalculated when priority changes; SLA clock paused while pending
- Breach detection every minute with notifications to assignee/group; escalation flags

**Automations**
- Rules on ticket created / ticket updated / time-based (every 10 min)
- Conditions on 18 fields with 12 operators; actions: set priority/status/type, assign group/agent, add/remove tags, add note, notify agent/group/assignee, escalate, mark spam

**People**
- Contacts (merge, block, portal access, tags), Companies (domains, tier, health, renewal), Agents & roles, Groups

**Knowledge base**
- Categories → folders (public / logged-in / agents-only) → articles (draft/published, tags, keywords, views, helpful votes)
- Public portal with search, popular articles, related articles, article feedback

**Customer portal**
- Self sign-up, submit tickets (with suggested articles while typing), attachments, reply, close/reopen, CSAT rating

**Reports**
- Overview (volume trend, status/priority/type/source, SLA compliance, CSAT, weekday/hour heat), agent performance, groups, companies, satisfaction, time tracking, CSV export

**Admin**
- General settings, agents, groups, SLA policies, automations, tags, business hours, custom ticket fields

**Other**
- JWT auth for agents and customers, role-based access (admin / agent / customer)
- In-app notifications (assignments, replies, SLA breaches, mentions, CSAT)
- Global search across tickets, contacts, companies and articles
- Auto-close resolved tickets after N days (configurable)

## API

All endpoints are under `/api` (see `backend/src/app.js`). The frontend dev server proxies `/api` and `/uploads` to the backend, so no CORS setup is needed in development.

Useful scripts in `backend/`:

| Script              | What it does                                   |
| ------------------- | ---------------------------------------------- |
| `npm run convex:push` | Push `convex/` schema + functions to the Nexus deployment |
| `npm run db:seed`   | Load demo agents, contacts, tickets, KB, rules (skips if data exists) |
| `npm run db:reset`  | Wipe all Convex tables + files, then seed      |
| `npm run dev`       | Start the API with auto-reload                 |

## Notes

- SLA targets are computed in calendar hours; business-hours schedules are stored and shown but not yet used to pause the SLA clock.
- Email sending is not wired up; replies and notifications are in-app. The data model (cc/to emails, sources) is ready for an email integration.
- Uploads are stored in Convex file storage and served by the API at `/uploads/<name>`.
