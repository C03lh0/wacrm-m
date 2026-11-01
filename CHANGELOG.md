# Changelog

User-visible changes in `wacrm`. Self-hosters: when pulling an update,
check this file for any **migration required** notes and apply the
matching SQL files from `supabase/migrations/` against your Supabase
project before restarting the app.

Versions follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Pre-1.0, `MINOR` bumps cover new modules; `PATCH` bumps cover bug fixes
and polish.

## [0.10.0] — 2026-10-31

Syncs this fork with 89 commits of upstream work (through upstream
PR #700). The headline is a **rebuilt dashboard** that leads with what
needs doing rather than vanity counters, and a long overdue pass on the
**inbox on a phone**. Behind those sits the largest database-integrity
wave upstream has shipped: thirteen migrations closing races, authz
holes and silent data loss across accounts, automations, flows, AI
replies, templates and broadcasts.

Everything the fork adds on top of upstream — WhatsApp via QR code
(Evolution API), plain-text broadcasts, the password-recovery session
lock, and the runtime language switcher — is unchanged and still works.
Two of upstream's fixes were ported *into* the fork's shared inbound
pipeline rather than left in the Meta webhook, so Evolution connections
get them too (see **Fixed**).

> **Migration required.** Apply these in order from
> `supabase/migrations/`:
> `047_account_membership_integrity.sql`,
> `048_quick_reply_content_matches_kind.sql`,
> `049_broadcast_params_jsonb.sql`,
> `051_automation_pending_integrity.sql`,
> `052_flow_run_integrity.sql`,
> `053_ai_reply_integrity.sql`,
> `054_webhook_status_integrity.sql`,
> `055_authz_membership_holes.sql`,
> `057_message_templates_account_unique.sql`,
> `058_engine_race_gaps.sql`,
> `059_dashboard_overview.sql`,
> `908_broadcast_plain_text_params_jsonb.sql`,
> `909_redeem_invitation_whatsapp_connections.sql`,
> `910_gen_random_uuid_defaults.sql`.
>
> There is no `050` or `056` — upstream reserved those numbers for PRs
> that were reworked before merging. The gap is harmless; migrations
> apply in filename order, not by sequence.
>
> To confirm the result, run `supabase/ci/verify-schema.sql` against
> your project. It is a single `DO` block, so a clean run returns no
> rows; a missing object raises an exception naming the migration.

> **Migration renumbering — this is the last time.** Upstream's sequence
> collided with this fork's for the third release running, so the fork's
> own migrations have moved into a **reserved `900` range** where
> upstream's numbering can never reach them again. Upstream keeps every
> number it uses:
>
> | was (0.9.0) | now |
> | --- | --- |
> | `039_contact_opt_out` | `901_contact_opt_out` |
> | `047_whatsapp_connections` | `902_whatsapp_connections` |
> | `048_message_idempotency` | `903_message_idempotency` |
> | `050_whatsapp_connections_backfill_status` | `904_whatsapp_connections_backfill_status` |
> | `051_broadcast_plain_text` | `905_broadcast_plain_text` |
> | `052_fix_broadcast_plain_text_contact_id_ambiguity` | `906_fix_broadcast_plain_text_contact_id_ambiguity` |
> | `053_whatsapp_connections_last_inbound_at` | `907_whatsapp_connections_last_inbound_at` |
>
> `049_inbound_media_mirror` moved in the other direction: it is
> upstream's file, displaced by an earlier collision, and is back at its
> own number `039`. Mind that `049` now means something else entirely —
> upstream's `049_broadcast_params_jsonb`, which is in the list above.
> **Check those two by filename, not by number.**
>
> The SQL inside the seven renamed files did not change, only their
> filenames. A fresh install needs nothing special. On an **existing**
> install they are already applied under their old numbers; all seven are
> re-runnable (`IF NOT EXISTS` / `CREATE OR REPLACE` throughout), so
> letting tooling replay them is harmless, and
> `supabase migration repair --status applied <version>` reconciles the
> ledger if you would rather not.

### Added

- **A dashboard that leads with what needs doing.** Replaces the counter
  grid with an attention row — unanswered conversations, stalled deals,
  broadcasts that failed — backed by a single database function instead
  of a dozen client queries, so it stays accurate on accounts with more
  than 1,000 of anything. Comes with a configurable **reply-time
  target**: the median first response is measured against the target you
  set rather than an assumed one.
- **The inbox works on a phone.** The composer is reachable and sized for
  touch, and Enter inserts a newline there instead of sending
  mid-sentence — sending is the button, as every other messaging app on a
  phone behaves.
- **Long threads load in pages.** Opening a conversation with months of
  history no longer fetches all of it; older messages load as you scroll
  up, and a message that failed to send stays visible in place instead of
  vanishing on the next refresh.
- **Templates render as they will arrive.** Header, footer and buttons now
  appear in the thread, so what you see before sending is what the
  customer gets. Templates with **named variables** (`{{order_id}}`, not
  just `{{1}}`) are supported end to end, including in the broadcast
  personalisation step.
- **Per-account reply-time target and inbox settings** under
  **Settings → Inbox**, plus a `/api/whatsapp/health` endpoint for
  checking a connection without opening the UI.

### Fixed

- **Broadcast personalisation could send the wrong values to the wrong
  people.** Per-recipient `{{1}}` parameters were passed to the database
  as `JSONB[]`, which PostgREST flattens into a 2-D scalar array — the
  pairing between contact and parameters was lost on any send with more
  than one variable. Both the upstream function and this fork's
  plain-text overload are re-cut to take `JSONB`.
  (Migrations `049` and `908`)
- **A first-time contact could trigger the first-inbound automation
  twice.** The "is this their first message" test counted prior messages,
  so two deliveries arriving together both saw zero. It is now an atomic
  claim on `conversations.first_inbound_at`: exactly one delivery wins.
  Ported into the fork's shared inbound pipeline, so **Evolution
  connections get this too**, not only Meta. (Migration `054`)
- **Delivery statuses could be applied across accounts and go
  backwards.** A status callback is now matched to the number that
  received it and only ever moves a message forward
  (`sent` → `delivered` → `read`), so a late `sent` callback no longer
  un-reads a read message.
- **Account membership could be corrupted or silently deleted.**
  Redeeming an invitation, transferring ownership and removing a member
  are now single atomic operations, with the privilege columns on
  `profiles` enforced by trigger rather than by the API alone. This
  fork's `whatsapp_connections` is included in the "is the old account
  empty" check, so an account holding nothing but an Evolution
  connection can no longer be deleted out from under it.
  (Migrations `047`, `055`, `909`)
- **Races across the engines.** AI handoff, flow-run transitions,
  knowledge ingestion and broadcast resume could each double-process work
  under concurrency; claims are now conditional updates and broadcast
  delivery takes a lease. Parked automation runs resume on the correct
  step, honour pauses, and respect the account's time zone.
  (Migrations `051`, `052`, `053`, `058`)
- **The inbound media proxy could serve active content from the app's own
  origin**, making a received file a vector for script execution against
  the dashboard. Responses now carry
  `Content-Security-Policy: default-src 'none'; sandbox` and `nosniff`,
  the content type is validated rather than echoed, and anything outside
  a small inline-safe list of image, audio and video types is forced to
  download instead of rendering.
- **WhatsApp configuration no longer reaches Meta without an admin.** The
  config endpoints require the admin role before forwarding anything, and
  routes that fan out to Meta or fire automations are rate budgeted. The
  inbound webhook caps the request body (4 MiB) and compares verify
  tokens in constant time.
- **The AI assistant stopped answering over a human.** After an agent
  takes over a conversation the assistant stays quiet, knowledge lookup
  matches any keyword rather than all of them, and a partially indexed
  document reports as such instead of appearing complete. A stored API
  key is only reused for the same provider *and* endpoint.
- **A fresh hosted database push failed on `uuid-ossp`.** Column defaults
  called `uuid_generate_v4()`, which on hosted Supabase is installed
  outside the search path a migration runs under — the extension line
  succeeded and the next `CREATE TABLE` failed with 42883. Defaults are
  `gen_random_uuid()` now, and migration `910` converges databases
  created before the change. (Migration `910`)
- Duplicate message templates per account are prevented by a unique
  index, templates and tags are scoped to the account, contact phone
  matching is strict with digit-aware search, `find-or-create` no longer
  wipes a contact's tags, and `DELETE` on a row outside the caller's
  account answers 404 instead of succeeding quietly.
  (Migrations `048`, `057`)

### Changed

- **Runtime moved to Node 22 LTS**, lifting the dependency caps Node 20
  held back. Next.js builds run Turbopack's PostCSS in worker threads.
- The inbox's message merging was replaced by upstream's optimistic
  message handling, which covers the same cases and more (temporary
  bubbles, realtime inserts, status updates, older-page prepends). The
  fork's `src/lib/inbox/merge-messages.ts` is gone.
- Dependency bumps: `@xyflow/react`, `@base-ui/react`, `lucide-react`,
  `next-intl`, `shadcn`, `prettier`.

## [0.9.0] — 2026-10-14

Syncs this fork with 64 commits of upstream work (through upstream
PR #637). Headline additions: automations can now **wait for a customer
reply** mid-run, the AI assistant accepts **any OpenAI-compatible
endpoint**, and the **password-reset / email-confirmation flow** finally
explains itself instead of dead-ending. Also carries two database
security fixes and a broadcast fix for audiences over 1,000 contacts.

Everything the fork adds on top of upstream — WhatsApp via QR code
(Evolution API), plain-text broadcasts, the password-recovery session
lock, and the runtime language switcher — is unchanged and still works.

> **Migration required.** Apply these in order from
> `supabase/migrations/`:
> `043_storage_scoped_select.sql`, `044_internal_definer_grants.sql`,
> `045_automation_wait_for_reply.sql`, `046_ai_openai_compatible.sql`.
>
> **The renumbering described below was superseded by 0.10.0**, which
> moved the fork's migrations into a reserved `900` range. If you are
> updating past this release, follow 0.10.0's table, not this one.

> **Migration renumbering (historical).** Upstream shipped its own
> `045` and `046`, colliding with this fork's, so the fork's seven
> Evolution migrations moved up to `047`–`053` and upstream's
> inbound-media file to `049`. **Those filenames no longer exist**:
> 0.10.0 moved the fork's files to the `900` range and returned
> upstream's to `039`. The table is kept above in 0.10.0, which maps
> the `047`–`053` names this release introduced to their final ones.
>
> What still applies from this release: upstream's `045` and `046`
> must be applied by hand on an existing install, or automations will
> park at a "wait for reply" step the database rejects and the
> OpenAI-compatible provider will fail to save.
>
> CI asserts every one of these objects exists
> (`supabase/ci/verify-schema.sql`), so a half-applied schema fails the
> build rather than surfacing as a runtime error weeks later.

### Added

- **"Wait for reply" automation step.** A Send Buttons / Send List step
  can now pause the run until the contact answers — their tap or typed
  reply becomes `message_text` for the steps that follow, and the run
  expires if nothing arrives inside WhatsApp's 24-hour service window.
  While a run is waiting, that message is "consumed": keyword triggers
  and the AI auto-reply stay quiet so the customer never gets two bots
  answering at once. Works on **both** connection types — Meta and
  Evolution (QR) inbound share the same pipeline here.
- **OpenAI-compatible AI provider.** Point the assistant at any
  OpenAI-shaped API (Ollama, vLLM, a gateway) under **Settings → AI
  Assistant** instead of being limited to OpenAI or Anthropic. Hosts
  outside the allow-list must be `https`, and private/link-local
  addresses are refused unless the operator opts in explicitly with the
  new `AI_PROVIDER_ALLOWED_PRIVATE_HOSTS` variable — so a user-supplied
  URL cannot be aimed at your internal network.
- **Email links that explain themselves.** `/auth/callback` now handles
  a link Supabase already rejected (expired or used) by sending the
  visitor to sign-in with a reason, supports reset templates built on
  `{{ .TokenHash }}` as well as the default PKCE ones, and emits
  relative redirects so links keep working behind a reverse proxy or
  tunnel instead of landing on `https://0.0.0.0:3000`. `/reset-password`
  gained a real "this link is no longer valid" screen with a button to
  request a fresh one. See `docs/auth-emails.md`.
- **Signed-out visitors are redirected from every dashboard route.**
  `/flows`, `/agents` and `/notifications` previously rendered a broken
  page instead of bouncing to sign-in. A test now reads the route folder
  itself, so a newly added page cannot be forgotten.

### Fixed

- **Broadcasts to more than 1,000 contacts silently dropped
  recipients.** Audience queries stopped at PostgREST's 1,000-row
  response cap, so a large "all contacts" or tag audience was quietly
  truncated. Audience resolution, recipient loading and the
  custom-field values used for `{{1}}`-style placeholders are all paged
  now. (Upstream #608)
- **Stored files were readable too widely.** Storage read policies on
  the avatars, flow-media and chat-media buckets are now scoped to the
  owning folder and to signed-in members, instead of applying to
  anonymous requests. (Migration `043`)
- **Internal database functions were callable by signed-in users.**
  `EXECUTE` on the engine's `SECURITY DEFINER` helpers (broadcast count
  recomputation, AI reply slots, webhook failure tracking, the dedupe
  merges) is now reserved to the service role. (Migration `044`)
- **Page HTML could be served from a shared cache.** Responses are
  `private, no-store`, so a CDN can't hand one visitor a page rendered
  for another — which matters here because page content varies by the
  language cookie.
- **Weekday labels ignored the chosen language.** The dashboard's
  response-time chart now formats weekdays in the active locale
  ("Mon", "seg.", …) rather than always in English.
- **Dependency and security updates.** Next.js 16.3.8, `supabase-js`,
  `next-intl`, `lucide-react`, `sonner` and `tailwind-merge` bumped,
  with minimum versions raised to clear open advisories.

### Changed

- **Only the active language is sent to the browser.** The client
  bundle now carries one message catalogue instead of all of them.
- Portuguese and Spanish translations filled in across the newly added
  screens and validation messages; Korean kept at parity.

## [0.8.1] — 2026-07-10

Fixes inbound chats fragmenting into multiple threads for the same
number.

> **Migration required:** apply `supabase/migrations/036_conversation_contact_dedup.sql`
> (merges any existing duplicate conversations into the oldest thread —
> no messages are lost — then adds a `UNIQUE (account_id, contact_id)`
> index so one contact can only ever have one conversation).

### Fixed

- **Duplicate chats for a single contact.** An inbound message could
  create a second conversation for a contact under a race (Meta retries a
  delivery, or a batch fans out to concurrent runs). Once two existed,
  the `.single()` lookup errored on every later message and the webhook
  created yet another conversation each time, snowballing into a wall of
  duplicate chats. The find-or-create now resolves to the oldest existing
  thread and a DB unique index makes the one-conversation-per-contact
  rule authoritative. The same hardening was applied to the public-API
  conversation resolver. (Issue #363)

## [0.8.0] — 2026-07-08

Polishes the AI auto-reply bot: it's now **visible and controllable from
the inbox**, its **handoff actually hands off**, and its **token spend is
logged**.

> **Migration required:** apply `supabase/migrations/033_ai_reply_polish.sql`
> (adds `messages.ai_generated`, `ai_configs.handoff_agent_id`,
> `conversations.ai_handoff_summary`, and the `ai_usage_log` table).

### Added

- **"AI" badge in the inbox.** Replies the bot sent are tagged with a
  small ✨ AI badge, so agents can tell an automated reply from their own
  or a Flow's at a glance. (New `messages.ai_generated` flag; only the
  auto-reply bot sets it.)
- **Take over / Resume from the thread.** A banner on AI-handled
  conversations lets an agent **Take over** (pauses the bot for that
  thread and assigns it to them) or **Resume AI** (hands the thread back
  and clears the pause). Backed by `POST /api/ai/autoreply/[id]`.
- **Real handoff.** When the bot bails (can't help, or hits the reply
  cap) it now (1) routes the conversation to a configurable **handoff
  target** — a specific agent, or the unassigned queue — and (2) leaves a
  short **internal note** summarizing the exchange for whoever picks it
  up. Assigning fires the existing assignment notification. Pick the
  target under **AI Agents → Setup → Hand off to**.
- **Token-usage logging + dashboard.** Every draft and auto-reply records
  its provider token counts to the new `ai_usage_log` table
  (admin-readable). A new **AI Agents → Usage** tab (admin-only) charts
  daily token spend on your BYO key with per-mode and per-model
  breakdowns, backed by `GET /api/ai/usage`. Counts only — no message
  content is stored or shown.

### Changed

- Auto-reply now has an **account-wide rate limit** (30/min) on top of
  the existing per-conversation cap, so a burst of inbound can't run your
  provider key past its limit. Over the limit, inbounds simply wait in
  the inbox for a human instead of being auto-answered.

## [0.7.0] — 2026-07-02

Promotes the AI assistant to a first-class **AI Agents** section in the
sidebar — it's no longer tucked inside Settings.

### Added

- **AI Agents (sidebar).** A dedicated `/agents` area with two tabs:
  - **Playground** — a test chat to message your agent and see its
    grounded, multi-turn replies (and where it would hand off to a human)
    *before* it ever answers a real customer. Runs the exact same path as
    the auto-reply bot (knowledge-base retrieval + your provider), and
    works even before you flip the master switch on, so you can try, then
    enable. Backed by `POST /api/ai/playground`.
  - **Setup** — the provider/key, business context, knowledge base, and
    auto-reply controls (moved here from Settings → AI Assistant).

### Changed

- The AI configuration moved out of **Settings → AI Assistant** into the
  new **AI Agents** section. No data change — same account config, new
  home. No migration required.

## [0.6.0] — 2026-07-02

Adds an **AI knowledge base** so the assistant (0.5.0) can answer from
your own content instead of handing off. Paste FAQs, policies, or
product details under **Settings → AI Assistant → Knowledge base**; the
relevant excerpts are retrieved into every draft and auto-reply.

### Added

- **Knowledge base with hybrid retrieval.** Lexical Postgres full-text
  search works for every account with no extra credentials. Optional
  **semantic search** (pgvector, OpenAI `text-embedding-3-small`) turns
  on when you add an **embeddings key** — semantic-primary, topped up
  with lexical to fill the result set. Anthropic-only accounts (Anthropic
  has no embeddings API) keep the lexical path with zero extra setup.
- **Knowledge base manager** in Settings — add/edit/delete documents and
  a **Reindex** action to backfill embeddings after adding a key. Both
  drafts and the auto-reply bot are grounded in the retrieved excerpts,
  and the prompt still instructs the model to hand off (auto-reply) or
  say it will follow up (draft) when the KB doesn't cover the question.
  **Migration required:** apply `supabase/migrations/030_ai_knowledge.sql`
  (enables `pgvector`; adds `ai_knowledge_documents` + `ai_knowledge_chunks`
  and an `embeddings_api_key` column on `ai_configs`).

## [0.5.0] — 2026-07-02

Adds the **AI reply assistant** — bring-your-own-key. Each account
pastes its own OpenAI or Anthropic key under **Settings → AI
Assistant**; wacrm calls the provider directly with that key, so
there's no per-seat AI fee and your conversation data never leaves
your own infrastructure for a wacrm-run service. The key is stored
AES-256-GCM-encrypted at rest (same as WhatsApp tokens) and never
returned to the client after saving.

### Added

- **AI-drafted replies in the inbox.** A ✨ button in the composer
  (agent+) reads the recent conversation and drops a suggested reply
  into the box for the agent to edit and send. Read-only server-side —
  `POST /api/ai/draft` never sends or stores anything. Respects your
  business context / persona from the settings prompt.
- **AI auto-reply bot.** When enabled, inbound messages that no
  deterministic Flow consumed and that have no agent assigned get an
  automatic LLM reply. Bounded by a per-conversation cap
  (`auto_reply_max_per_conversation`, default 3) and a clean human
  handoff: when the model can't confidently help — or the customer
  asks for a person — it stays silent and leaves the message for a
  human, and won't auto-reply on that thread again until re-enabled.
  Flows always win over the bot.
- **Settings → AI Assistant** (admin+ to edit): pick provider + model,
  paste your key, add business context/tone, toggle the assistant and
  auto-reply, set the per-conversation cap, and **Test key** against
  the provider before saving.
- Providers: OpenAI (Chat Completions) and Anthropic (Messages) behind
  one interface; model is a free-text field with sensible defaults, so
  you can point it at any current model your key can access.
  **Migration required:** apply
  `supabase/migrations/029_ai_reply.sql` (adds `ai_configs` +
  per-conversation auto-reply columns on `conversations`).

## [0.4.0] — 2026-07-01

Completes the public API (#245): **outbound event webhooks** so
automations can *react* to activity instead of polling.

### Added

- **Outbound event webhooks (`/api/v1/webhooks`).** Register an HTTPS
  endpoint (scope `webhooks:manage`) to be POSTed to when an event
  happens in your account — `message.received`, `message.status_updated`,
  or `conversation.created`. Manage endpoints with
  `GET/POST /api/v1/webhooks` and `GET/PATCH/DELETE /api/v1/webhooks/{id}`.
  Each delivery is signed with an `X-Wacrm-Signature`
  (HMAC-SHA256 over `timestamp.body`) so receivers can verify
  authenticity and reject replays; the signing secret is returned once
  at creation and stored encrypted. Delivery is best-effort — an
  endpoint that fails repeatedly is auto-disabled after a threshold of
  consecutive failures. See `docs/public-api.md`.
  **Migration required:** apply
  `supabase/migrations/028_webhook_endpoints.sql`.
  ([#245](https://github.com/ArnasDon/wacrm/issues/245))

## [0.3.0] — 2026-07-01

Multi-user accounts ship. Every wacrm install is multi-tenant on the
database side: a single user's signup creates a fresh "account", and
every row is scoped to that account rather than to the user directly.
This release also opens the user-visible **Members** surface — invite
teammates by link, manage their roles, transfer ownership — to all
users. The `'account_sharing'` beta gate that hid it during
development is removed (mirrors the Flows soft-GA in 0.2.0). Existing
self-hosted instances keep working: every existing user is backfilled
as the sole owner of their own account and sees identical data, and a
solo owner who never invites anyone sees the same single-user app they
always did.

### Added

- **Public REST API (`/api/v1`) — groundwork.** A scoped, revocable
  **API key** system so you can drive wacrm from your own scripts and
  automations. Create keys under **Settings → API keys** (admin+),
  grant only the scopes each integration needs, and authenticate with
  `Authorization: Bearer <key>`. Keys are account-scoped and stored
  hashed (plaintext shown once). This release ships the auth layer,
  scopes, per-key rate limiting, the management UI, and a
  `GET /api/v1/me` probe to verify a key. See
  `docs/public-api.md`. **Migration required:** apply
  `supabase/migrations/026_api_keys.sql`. ([#245](https://github.com/ArnasDon/wacrm/issues/245))
- **Public REST API — data endpoints.** Built on the key auth above,
  so external automations can read and drive the CRM:
  - `POST /api/v1/messages` — send a text / template / media message to
    a phone number; finds-or-creates the contact + conversation
    (`messages:send`).
  - `GET/POST /api/v1/contacts`, `GET/PATCH /api/v1/contacts/{id}` —
    list (search + tag filter), create (find-or-create by phone), read,
    and update contacts, including tags (`contacts:read` /
    `contacts:write`).
  - `GET /api/v1/conversations`, `GET /api/v1/conversations/{id}`, and
    `GET /api/v1/conversations/{id}/messages` — browse conversations and
    their message history with delivery status (`conversations:read` /
    `messages:read`).
  - `POST /api/v1/broadcasts` + `GET /api/v1/broadcasts/{id}` — launch a
    template broadcast to a recipient list and poll its progress
    (`broadcasts:send`).
  All list endpoints share one cursor-pagination contract
  (`{ data, meta: { next_cursor } }`). No migration required — the
  scopes already existed and the tables are unchanged. Outbound event
  webhooks (react to inbound messages) are the remaining roadmap item.
  See `docs/public-api.md`. ([#245](https://github.com/ArnasDon/wacrm/issues/245))

### Changed

- **Tenancy moves from per-user to per-account.** RLS on every
  domain table (contacts, conversations, messages, broadcasts,
  automations, flows, pipelines, templates, tags, …) now checks
  account membership via a new SECURITY DEFINER helper
  `is_account_member(account_id, min_role)` instead of
  `auth.uid() = user_id`. The `user_id` columns stay on every row
  for assignment / audit but no longer enforce isolation.
- **WhatsApp config is one-per-account, not one-per-user.** The
  `whatsapp_config.UNIQUE(user_id)` constraint is replaced by
  `UNIQUE(account_id)`.
- **`flow_runs` idempotency key swaps to `(account_id, contact_id)`**
  so two accounts sharing a contact phone number can each run their
  own flows independently.
- **The signup trigger (`handle_new_user`) now also creates a
  personal account** and links the new profile to it as `owner`.

### Changed

- **Flow-media storage is now account-scoped.** Migration 016
  pathed uploaded files under `auth.uid()/...`, which orphaned
  flow media when a teammate left a shared account. New uploads
  go under `account-<account_id>/...` and any account member
  with the right role can edit them. Legacy paths remain
  writable by the original uploader for backward compatibility.
- **Webhook contact lookup now pre-filters in SQL.** Previously
  pulled every contact in an account just to JS-filter to one
  row by phone — fine when account = one user, painful when
  account = team. Pre-filter by phone suffix on the database
  side; re-apply `phonesMatch` on the (typically 0-2 row)
  candidate set.

### Migration required

- `supabase/migrations/020_account_sharing_followups.sql` —
  composite partial indexes on `automations(account_id,
  trigger_type) WHERE is_active` and `flows(account_id) WHERE
  status='active'` for the engine dispatch hot path; updated
  `flow-media` storage RLS to allow account-member writes under
  the new path convention. Idempotent.

- **Role-aware UI gating across the app.** The inbox composer's
  send button + textarea, the "New broadcast / automation / flow"
  buttons, the "Add pipeline / deal" buttons, and the "Add /
  Import contact" buttons are now disabled-with-tooltip for
  viewers (and for agents on settings-class actions). Choice:
  show-but-disable rather than hide, so the UI never feels
  silently broken to a teammate looking at a feature they don't
  yet have permission for.
- **Sidebar surfaces the active account** above the user info
  whenever the account name differs from your own — i.e. once
  you've renamed the account or joined a shared one. A default
  solo account is named after you, so the strip stays hidden to
  avoid duplicating your name in the footer.
- **Members is open to all users.** The `account_sharing` beta
  flag that hid the Settings → Members tab and the sidebar
  account strip during development is gone; the multi-user
  surface is now part of the standard app. (Same soft-GA move as
  Flows in 0.2.0.)

### Fixed

- **Inbound WhatsApp messages now land in the shared inbox.** The
  webhook + automations + flows engines used to route inbound
  events by `user_id`, which after the 017 migration only matched
  the WhatsApp config owner's automations / flows — teammates'
  rules never fired. PR 8 of the multi-user series flips every
  lookup to `account_id` so any member of the account sees the
  inbound message and any teammate's automation or flow can react
  to it. Also fixes incipient NOT NULL violations on
  `automation_logs`, `automation_pending_executions`, `flow_runs`,
  and `deals` — those tables gained `account_id NOT NULL` in 017
  but the engines hadn't yet been updated to populate it.

### Added

- **Duplicate phone numbers are now prevented across contacts.** A
  phone number can no longer become more than one contact in the same
  account. Adding a contact whose number already exists is blocked
  with a link to the existing record (and a softer warning for
  near-matches that share their last 8 digits); CSV import de-dupes
  within the file and against existing contacts, reporting
  "X imported, Y duplicates skipped". The rule is enforced by a
  database unique index on the normalized number, so the WhatsApp
  webhook, the form, import, and any future path all agree. Existing
  duplicates are merged into the oldest contact on upgrade (their
  conversations, deals, notes, and tags are re-pointed, nothing is
  lost). Closes #212.
- **Configurable default deal currency.** Each account can now pick
  its default currency under **Settings → Deals** (admin+); the app
  previously hardcoded USD throughout. New deals default to it, and
  pipeline-stage totals, the dashboard "Open Deals Value" card, the
  pipeline-value donut, and automation-created deals all use it.
  Existing deals keep the currency they were saved with — totals are
  shown in the account default with no exchange-rate conversion (one
  currency per account). Full guide:
  [Default currency](https://wacrm.tech/docs/settings#deals).
- **Members tab in Settings.** The user-facing surface for the
  multi-user APIs below, available to everyone (no beta flag). From
  Settings → **Members** an admin or owner can: see who's on the
  account with their role and join date, invite teammates by
  generating a one-time share link (pick the role + optional
  expiry), revoke pending invites, change a member's role, remove a
  member, and — as owner — transfer ownership. Recipients accept via
  a public `/join/[token]` page. Full guide:
  [Members docs](https://wacrm.tech/docs/members).
- **Account & member management API** — server-side endpoints
  backing the Members tab. All routes are role-gated and
  return Supabase-RLS-scoped data.
  - `GET /api/account` — caller's account + role. Any member.
  - `PATCH /api/account` — rename the account. Admin+.
  - `GET /api/account/members` — list members. Email visible to
    admin+ only; agents/viewers see name + avatar + role +
    joined date.
  - `PATCH /api/account/members/[userId]` — change a member's
    role. Admin+. Owner promotion/demotion goes through the
    transfer endpoint instead.
  - `DELETE /api/account/members/[userId]` — remove a member.
    Admin+. The removed user keeps their login and is moved to a
    freshly-created personal account (mirror of the signup flow).
  - `POST /api/account/transfer-ownership` — owner only. Atomic
    swap with the named member.
- **Invitation API + redeem flow** — the no-email, link-only
  invite path that powers the Members tab's "Invite member" button
  and the `/join/[token]` accept page.
  - `GET /api/account/invitations` — list outstanding (admin+).
  - `POST /api/account/invitations` — create an invite, returns
    the plaintext token + share URL **exactly once** (we store
    only the SHA-256 hash on the row). Body
    `{ role, expiresInDays?, label? }`. Admin+.
  - `DELETE /api/account/invitations/[id]` — revoke (admin+).
  - `GET /api/invitations/[token]/peek` — public, per-IP
    rate-limited. Returns `{ ok, account_name, role, expires_at }`
    or `{ ok: false, reason }` so the join page can render
    "You're being invited to <Account> as <Role>".
  - `POST /api/invitations/[token]/redeem` — authenticated.
    Atomically moves the caller's profile to the inviter's
    account and cleans up the orphan personal account. Refuses
    with 409 if the caller's current account already contains
    domain data (no silent data loss).

### Migration required

Apply against your Supabase project before deploying this version:

- `supabase/migrations/017_account_sharing.sql` — introduces the
  `accounts` and `account_invitations` tables plus an
  `account_role_enum` type; adds `account_id` to every
  user-scoped table and backfills it; rewrites every RLS policy;
  replaces the new-user trigger. Idempotent. **No data loss** —
  every existing user is mapped to a freshly-created account
  with role `owner` and every existing row of theirs is linked
  to that account.
- `supabase/migrations/018_account_member_rpcs.sql` — adds three
  `SECURITY DEFINER` RPCs (`set_member_role`,
  `remove_account_member`, `transfer_account_ownership`) that
  back the member-management API. They self-check the caller's
  role and raise SQLSTATE `42501` / `22023` on forbidden / bad
  input so the API layer can map cleanly to 403 / 400.
  Idempotent.
- `supabase/migrations/019_invitation_rpcs.sql` — adds two
  `SECURITY DEFINER` RPCs: `peek_invitation` (anonymous read by
  token hash, returns a fixed-shape JSON envelope) and
  `redeem_invitation` (authenticated atomic move + orphan
  cleanup, with a domain-data safety check). Both bypass the
  RLS that would otherwise block their reads/writes. Idempotent.
- `supabase/migrations/021_account_default_currency.sql` — adds
  `accounts.default_currency` (`TEXT NOT NULL DEFAULT 'USD'`, with a
  3-letter-code `CHECK`) backing the configurable default currency.
  Idempotent; existing accounts backfill to `USD`. **Apply before
  deploying** — the app now reads this column when loading the
  account, so an un-migrated database breaks account loading.
- `supabase/migrations/022_contact_phone_dedup.sql` — adds the
  generated `contacts.phone_normalized` column, **merges existing
  duplicate contacts into the oldest** (re-pointing conversations,
  deals, notes, tags, custom values, and broadcast recipients — no
  data loss), then adds a `UNIQUE (account_id, phone_normalized)`
  index. Idempotent. **Apply before deploying** — CSV import reads
  `phone_normalized`, and the index is what enforces de-duplication
  for every write path. The one-shot merge runs inside the migration.

## [0.2.2] — 2026-05-29

Flow nodes can now send media. Closes the most-requested gap from user
feedback after the v0.2.0 Flows launch — flows were text-only and
couldn't deliver an invoice, receipt, product photo, or short demo
video mid-conversation.

### Added

- **`send_media` flow node.** Send an image (PNG / JPEG / WebP), video
  (MP4 / 3GP), or document (PDF, Word, Excel, PowerPoint, TXT) to the
  customer from any point in a flow. Pick a file in the builder, it
  uploads to the new `flow-media` Supabase Storage bucket, and Meta
  fetches the public URL at send time. Optional caption (1024 char cap,
  supports `{{vars.X}}` interpolation); documents also take an optional
  filename shown in the recipient's chat. Auto-advances after send —
  same suspend semantics as `send_message`.
  ([#156](https://github.com/ArnasDon/wacrm/pull/156))

### Migration required

Apply against your Supabase project before deploying this version:

- `supabase/migrations/016_flow_media.sql` — does two things:
  1. Adds `'send_media'` to the `flow_nodes.node_type` CHECK
     constraint. Without this the `send_media` node fails to save with
     a constraint violation.
  2. Creates the public `flow-media` Supabase Storage bucket (16 MB
     file-size cap, image / video / document MIME allowlist) plus
     per-user RLS policies (path prefix = `auth.uid()`). Without this
     the builder's file picker fails on upload. Same shape as the
     `avatars` bucket from migration 008 — the bucket is **public** so
     Meta can fetch the URL without credentials.

The migration is idempotent and safe to re-run.

## [0.2.1] — 2026-05-26

Bug-fix release. Plugs a silent inbound-message drop that triggered
when two users on the same instance saved the same WhatsApp
`phone_number_id`.

### Fixed

- **Inbound WhatsApp messages no longer silently disappear** when two
  users have claimed the same `phone_number_id`. Previously the
  webhook used `.single()` to look up the owning config, which errors
  `PGRST116` for both 0 rows *and* ≥2 rows — the second user's save
  put the DB into the ≥2-row state and every inbound message was
  dropped while the log misleadingly reported *"No config found for
  phone_number_id"*. Three layers of fix: `POST /api/whatsapp/config`
  now returns **409** when another user has already claimed the
  number, the webhook lookup distinguishes 0 rows from ≥2 rows and
  logs the conflicting `user_id`s, and a new DB constraint
  (`UNIQUE(phone_number_id)`) prevents the bad state at the storage
  layer. Reported in
  [#136](https://github.com/ArnasDon/wacrm/issues/136), fixed in
  [#143](https://github.com/ArnasDon/wacrm/pull/143).

### Migration required

Apply against your Supabase project before deploying this version:

- `supabase/migrations/013_whatsapp_config_phone_number_id_unique.sql`
  — adds `UNIQUE(phone_number_id)` to `whatsapp_config`. **Fails
  loudly with a copy-pasteable resolution hint** if duplicate rows
  already exist; auto-deduping would destroy encrypted tokens, so
  the operator picks which row keeps the number. To check first:

  ```sql
  SELECT phone_number_id, array_agg(user_id) AS owners, count(*) AS n
  FROM whatsapp_config
  GROUP BY phone_number_id
  HAVING count(*) > 1;
  ```

  If that returns rows, `DELETE` the duplicate row(s) you want to
  drop, then re-run the migration.

### Note on multi-user setups

wacrm is intentionally **single-tenant per WhatsApp number**. RLS on
`conversations`/`messages` is `auth.uid() = user_id`, so a second
user physically cannot read messages routed to a different owner —
two users sharing one number was never supported. If you need
multiple humans handling the same inbox, run them under one shared
account.

## [0.2.0] — 2026-05-22

The **Flows** release. Adds a no-code, branching, button-driven WhatsApp
conversation engine that runs alongside Automations. Also ships a
5-theme color picker in Settings and opens Flows to all users.

### Added

#### Flows — branching chatbot conversations

- **Module + schema.** New `flows`, `flow_nodes`, `flow_runs`,
  `flow_run_events` tables with partial unique indexes that enforce
  one active run per contact. Widened `messages.content_type` CHECK
  to accept `'interactive'`; added `interactive_reply_id` column so
  the inbox can render button/list taps.
  ([#112](https://github.com/ArnasDon/wacrm/pull/112))
- **Runner engine.** `dispatchInboundToFlows` parses every inbound
  webhook, decides whether the message is a reply on an active run
  or a fresh trigger, advances the state machine, and reports back
  to the webhook so consumed messages don't also fire automations.
  Idempotent on Meta's `message_id`.
  ([#114](https://github.com/ArnasDon/wacrm/pull/114))
- **No-code builder UI** at `/flows`. Linear-list editor with
  per-node config forms, live validator, draft/active/archived
  status, and a 5-route REST API (`GET/POST /api/flows`,
  `GET/PUT/DELETE /api/flows/[id]`, `POST /api/flows/[id]/activate`,
  `GET /api/flows/[id]/runs`, `GET /api/flows/templates`).
  ([#115](https://github.com/ArnasDon/wacrm/pull/115))
- **Templates + v1.5 node types.** Three starter templates
  (Welcome menu, FAQ bot, Lead capture) cloneable from the New-flow
  dialog. Three new node types: `collect_input` (capture customer
  text into a variable), `condition` (branch on var / tag / contact
  field), `set_tag` (add or remove a tag). `{{vars.X}}` interpolation
  in send_message + collect_input prompts. Per-flow run-history
  viewer at `/flows/[id]/runs`.
  ([#117](https://github.com/ArnasDon/wacrm/pull/117))
- **Stale-run sweep cron** at `GET /api/flows/cron` — marks runs
  past their configured timeout (default 24h) as `timed_out` so
  abandoned conversations free up the contact for new triggers.
  Reuses `AUTOMATION_CRON_SECRET`.
  ([#114](https://github.com/ArnasDon/wacrm/pull/114))

#### Color themes

- **5 color themes** (Violet default, Emerald, Cobalt, Amber, Rose)
  selectable from a new **Appearance** tab in Settings. CSS variables
  scoped under `html[data-theme="..."]`, applied at runtime via
  `dataset.theme`, persisted to `localStorage`. Inline boot script in
  `layout.tsx` replays the choice before first paint so there's no
  flash of the default.
  ([#132](https://github.com/ArnasDon/wacrm/pull/132))
- **Theme tokenization sweep** — every previously hard-coded
  `violet-*` Tailwind class replaced with `primary` tokens across
  ~49 files. Picking a non-violet theme now themes the whole app,
  not just the chrome.
  ([#133](https://github.com/ArnasDon/wacrm/pull/133))

### Changed

#### Flows — soft-GA

- **Flows is now available to every authenticated user.** The
  per-account beta gate is gone; the sidebar entry + page header
  carry a small "Beta" chip as the only remaining signal.
  ([#134](https://github.com/ArnasDon/wacrm/pull/134))
- **Editor UX**:
  - Internal `node_key` + per-button/row `reply_id` identifiers
    hidden behind a per-node "Show advanced" disclosure.
    ([#118](https://github.com/ArnasDon/wacrm/pull/118))
  - `send_list` nodes can have multiple sections.
    ([#119](https://github.com/ArnasDon/wacrm/pull/119))
  - Collapsed node cards show a 1-line content preview per node
    type (text excerpt, button titles, condition summary, etc.).
    ([#120](https://github.com/ArnasDon/wacrm/pull/120))
  - Validation issues are clickable: jump to + flash the offending
    node.
    ([#121](https://github.com/ArnasDon/wacrm/pull/121))
  - Unsaved-changes "● Edited" indicator + `beforeunload` reload
    guard.
    ([#122](https://github.com/ArnasDon/wacrm/pull/122))
  - New-flow dialog actually widens to fit the 3 template cards
    (was capped at 384px by a baked-in `sm:max-w-sm` from shadcn).
    ([#129](https://github.com/ArnasDon/wacrm/pull/129),
    [#131](https://github.com/ArnasDon/wacrm/pull/131))
  - Validation panel pinned to the viewport bottom so
    activate-readiness follows the user as they scroll through nodes.
    ([#130](https://github.com/ArnasDon/wacrm/pull/130))

#### Engine reliability

- **Atomic `execution_count` increment** via SECURITY DEFINER RPC —
  prevents lost counts when two webhooks start runs concurrently.
  Mirrors the automations engine pattern.
  ([#124](https://github.com/ArnasDon/wacrm/pull/124))
- **Preload all flow_nodes once per dispatch** — one SELECT per
  inbound instead of one per advance-loop iteration. A 5-node
  auto-advance chain now costs 1 round trip, not 5.
  ([#125](https://github.com/ArnasDon/wacrm/pull/125))
- **Wasted re-read dropped** after reprompt reset; `loadActiveRun`
  switched to defensive `.limit(1)` so a migration glitch producing
  duplicates can't crash dispatch.
  ([#126](https://github.com/ArnasDon/wacrm/pull/126))

### Security

- **PII redacted from `reply_received` event payload** — customer
  text is no longer persisted to `flow_run_events.payload`; only
  the length is. A `collect_input` prompt asking "what's your card
  number?" used to leave the PAN sitting in the events table.
  ([#123](https://github.com/ArnasDon/wacrm/pull/123))
- **Constant-time cron-secret compare** on `/api/flows/cron`
  (`crypto.timingSafeEqual`) to close a theoretical
  timing-side-channel on the `x-cron-secret` header check.
  ([#127](https://github.com/ArnasDon/wacrm/pull/127))

### Fixed

- **`/flows` no longer spuriously redirects to `/dashboard`** when
  navigating in. Root cause: `useAuth` flipped `loading: false`
  before the profile fetch resolved. `use-auth` now exposes a
  separate `profileLoading` boolean.
  ([#128](https://github.com/ArnasDon/wacrm/pull/128))

### Migration required

Apply, in order, against your Supabase project:

1. `supabase/migrations/010_flows.sql` — Flows core tables, indexes,
   RLS policies, and the `messages` schema widening.
2. `supabase/migrations/011_profile_beta_features.sql` — adds the
   `profiles.beta_features` column. Surviving for future betas;
   Flows no longer reads it.
3. `supabase/migrations/012_flows_increment_counter.sql` — atomic
   counter RPC. Without this the engine still runs but
   `flows.execution_count` is racy.

Each migration is idempotent — safe to re-run if you're not sure
whether you applied a previous one.

### Removed

- **`src/lib/flows/feature-flag.ts`** + its tests. Flows is open to
  all users; the `profiles.beta_features` column itself survives
  for future beta gates.
  ([#134](https://github.com/ArnasDon/wacrm/pull/134))

---

## [0.1.1] — 2026-05-19

### Added

- Chat actions in the inbox: emoji reactions, reply-with-quote, and
  copy-text on individual messages. Hover on desktop, long-press on
  touch. Outbound reactions and replies forward to WhatsApp via the
  Cloud API; inbound reactions and swipe-replies from customers
  arrive through the webhook and appear in real time.

### Migration required

- Apply `supabase/migrations/009_message_actions.sql` to your
  Supabase project. It adds `messages.reply_to_message_id` and the
  new `message_reactions` table (with RLS and realtime). The
  migration is idempotent — safe to re-run.

### Changed

- The webhook no longer stores inbound customer reactions as fake
  text messages. They are written to `message_reactions` instead,
  so any custom queries that counted reactions as messages will
  need updating.

---

## [0.1.0]

Initial template release. Core CRM: inbox, contacts, pipelines,
broadcasts, automations (with a Wait-step cron drain), WhatsApp
Cloud API integration, Supabase auth + RLS.
