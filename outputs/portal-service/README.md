# NIOS Best Academy portal service

This is the secure backend companion for the static site in the parent folder. It runs locally with a realistic mock NIOS provider, local document storage, server-sent browser events, and mock notifications. It also contains production adapters for manual official-review workflows, S3-compatible storage, Twilio SMS/WhatsApp, WATI, and a signed approved-connector boundary.

## Start locally

1. Copy `.env.example` to `.env`.
2. Set a development key or omit it while `NODE_ENV=development`.
3. Run `npm start` from this folder.
4. Open [http://localhost:3000](http://localhost:3000). The service hosts the public pages in the parent folder and exposes `/api/*`.

Development accounts are included only for local preview: student `aarav@example.com` / `student123`, teacher `teacher@niosbest.in` / `teacher123`, and admin `admin@niosbest.in` / `admin123`. Remove or rotate these before deployment. New student accounts can also be created on the shared sign-up page.

Sign in at `/auth.html`, then use the Student Desk’s **Connect NIOS record** and **Refresh sync** controls. The mock student id is `demo-aarav`; API calls require the signed session created by this shared login. The dashboard is available at `/dashboard` and the operations console at `/admin`. Admins can use `/admin/batches` to create, edit, publish, or remove future batches, including their board, stream, admission route and learner-visible features; published batches feed the public home page.

Profiles support NIOS, IGNOU, CBSE Private, and DU SOL board codes plus subject mappings (subject code, class/stream, TMA state, practical-guide access, and progress). Each sync adds an immutable development log with `PENDING`, `SUCCESS`, `FAILED`, or `PORTAL_OFFLINE`; students see their own logs and admins can see the operational feed.

## Admission routing, payment, and batch access

`GET /api/admission-cycle` calculates the current NIOS window in the `Asia/Kolkata` calendar:

- Stream 1 Block 1: March 16–September 15; April/May target.
- Stream 1 Block 2: September 16–March 15; October/November target.
- Stream 2: May 1–July 15; October target.
- Stream 3/4 On-Demand: open outside April–May and October–November.

The last 14 days of a Stream 1 window (and the last 10 days of Stream 2) are marked as the academy late-fee warning period. Public batches are returned only while their configured NIOS admission route is open. A payment order records a deterministic assigned code such as `BATCH-S1B2-OCT2026-SCIENCE`.

The enforced order is: select a batch → sign in → select subjects offered by that batch’s class and stream, then submit identity proof, date-of-birth proof, educational qualification proof, residence proof, a recent photo, and signature → admin-email payload → full payment → restricted paid status → NIOS verification. The application also clearly labels conditional uploads for TOC/re-admission, category, disability, ex-serviceman, foreign-equivalence, and academy-requested records. Payment orders are rejected until the required document application is submitted. `/dashboard` serves an explicit payment-pending screen before payment, then a restricted “Payment Received — Admission Application Pending Admin Processing” view after payment. Only a background sync response with `admissionConfirmed: true` moves a `VERIFICATION_IN_PROGRESS` application to `ACTIVE`; only then can it call materials, live-classes, homework, or download APIs. Those queries additionally filter on batch, board, class, stream, and selected subject code.

`/teacher-portal` schedules target-batch live classes, posts homework, uploads tagged material, and grades submissions. The live-class endpoint enables its join link only in the ten minutes before the scheduled start.

For a public site without an approved NIOS data connector, set `NIOS_SYNC_MODE=manual`. In this mode, sync never manufactures documents or confirms an application. After a paid student’s official NIOS record has been checked, an authenticated admin starts verification, then explicitly selects **Confirm official admission & unlock Desk**. This records the admin action in the audit log, notifies the student through the configured notification provider, and grants batch-isolated materials and live-class access. Do not use `mock` in production: it exists only to exercise the local development flow.

## Production configuration

The addresses `niosbest.tvl@gmail.com` and `tkcrackjee@gmail.com` are permanent protected super administrators. They cannot be demoted through the staff API. On a fresh production deployment, use one of them as `BOOTSTRAP_ADMIN_EMAIL` with a unique 12+ character server-only password. That owner can then open `/admin/staff` and send a single-use, 24-hour Resend invitation to the second owner and to teachers.

If both owners are locked out, set a fresh 32+ character `ADMIN_ACCOUNT_RECOVERY_TOKEN` temporarily in Render, deploy, and open `/recover-admin`. The form accepts only a permanent owner email, requires the server-only token, uses it once, and records an audit event without emailing or exposing a password. Remove or rotate the token immediately after recovery; it never replaces an existing owner password merely by being set.

The owner controls can assign teachers to specific batches, allow or deny live-class scheduling, homework creation, material uploads and grading, suspend a teacher account, and restrict or restore individual online classes. These rules are enforced by the API, not only by the interface.

- Generate a new 32-byte key with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and set `APP_ENCRYPTION_KEY`.
- After `niosbest.in` is connected to this service and its HTTPS certificate is active, set `APP_PUBLIC_URL=https://niosbest.in`. Until that exact HTTPS origin is configured, the server deliberately returns `noindex` headers for public pages and serves a crawler-blocking `robots.txt` from preview hosts, so Render cannot compete with the real domain in search results.
- Use Supabase Postgres for production application state. Apply [`migrations/001_portal_state.sql`](./migrations/001_portal_state.sql) in **Supabase Dashboard → SQL Editor**, then set `PORTAL_STATE_DRIVER=supabase`, `SUPABASE_URL`, and the server-only `SUPABASE_SERVICE_ROLE_KEY`. Leave `SUPABASE_STATE_SCHEMA=public`, `SUPABASE_STATE_TABLE=portal_state`, and `SUPABASE_STATE_ROW_ID=primary` at their defaults unless the migration was intentionally customized. `PORTAL_STATE_DIR` and `.portal-data` are development/test only; never deploy them as a production database. In production, the portal keeps public pages readable but rejects registration, uploads, payments, webhooks, and admin/teacher writes with `DURABLE_STATE_REQUIRED` until both the Supabase state store and remote object storage are configured. Set `BOOTSTRAP_ADMIN_EMAIL` and a unique 12+ character `BOOTSTRAP_ADMIN_PASSWORD` to create the first admin on the initial durable start. Demo accounts are disabled in production and a startup check blocks any production state that contains them.
- Replace local storage with an S3-compatible bucket (`STORAGE_DRIVER=s3`) or Supabase Storage (`STORAGE_DRIVER=supabase`). Production writes remain blocked until remote state and all matching object-storage variables are present: `SUPABASE_URL`, `SUPABASE_BUCKET`, and `SUPABASE_SERVICE_ROLE_KEY` for Supabase; or `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY` for S3. An optional custom `S3_ENDPOINT` must be HTTPS in production. For Supabase, `SUPABASE_SERVICE_ROLE_KEY` accepts either the modern server-only `sb_secret_...` key or a legacy `service_role` JWT. Stored documents remain private and are downloaded through this authenticated server endpoint.
- Choose `NOTIFICATION_PROVIDER=resend-email` to send student alerts through the configured Resend sender; or choose Twilio SMS/WhatsApp, WATI, or a generic webhook by setting the corresponding notification variables.
- Set `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET`. The browser uses Razorpay's hosted checkout; the server verifies the returned signature and independently accepts only HMAC-verified `payment.captured` webhooks. Never activate an enrollment from a client-only success page.
- Set `RESEND_API_KEY`, `ADMIN_ADMISSION_EMAIL`, and a verified `ADMISSION_EMAIL_FROM` for direct admin-inbox delivery; or use `ADMISSION_INTAKE_WEBHOOK_URL` for a trusted email/workflow bridge. The payload includes subject choices and protected document references; files remain in private storage and are downloaded only in the authenticated admin portal. New student accounts also use the same verified sender (or `EMAIL_VERIFICATION_FROM`) for a free six-digit email code. Before public account creation is enabled in production, the portal performs a read-only Resend domain-list check for that exact sender domain; it fails closed when the sender is unverified, rejected, or unreachable, and the public response never identifies the provider or domain. This check never sends an email. Codes expire after 10 minutes, are HMAC-hashed before state is stored, and are never returned in production. Email verification requires the mailbox holder to choose a new 12+ character final password after entering the code, so a pending registration cannot be pre-claimed by someone who knows its initial password. If a delivery attempt fails after a successful readiness check, public sign-up is paused immediately, the endpoint remains generic, and the internal audit preserves an earlier valid code when possible. `EMAIL_VERIFICATION_TEST_MODE=true` is for isolated local automated tests only and must never be deployed.
- For automatic Zoom meeting creation, set `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, and `ZOOM_HOST_USER_ID`. The host value must be the licensed Zoom host's email address or Zoom user ID; Server-to-Server OAuth has no `/users/me` context. Teachers can always paste an approved HTTPS Zoom or Meet link instead.
- Put an authorised server-to-server NIOS connector behind `OFFICIAL_NIOS_CONNECTOR_URL`; that connector must have written permission and perform the official authentication journey without defeating CAPTCHA, OTP, rate limits, or access controls.
- Set `TRUST_PROXY=true` only behind a trusted reverse proxy that overwrites `X-Forwarded-For`; otherwise the server deliberately ignores that client-controlled header when rate-limiting sign-in and verification attempts. Protect the admin API with `ADMIN_API_TOKEN`; in production, add real authentication/authorization ahead of the API gateway.

### Render health and safe availability states

For this repository-root deployment, use Render's build command `echo "No build required"`, start command `node outputs/portal-service/server.mjs`, and health-check path `/api/health`. A `200` response means the web server can serve public pages; it does **not** mean the portal is allowed to accept student records. Check `readyForWrites: true` before announcing live admissions. When it is false, the site remains readable, existing users can still reach their signed-in pages, and the public batch, account, admission, and payment screens show a clear temporary-pause message rather than collecting data into Render's ephemeral disk.

`GET /api/public/availability` is safe to use from the public interface. It deliberately reports only whether sign-in, new-account verification, applications, and payments are currently available; it never reveals a provider, key, bucket, endpoint, or missing secret. For the full owner-only readiness view, sign in as an administrator and open `/admin/operations`. The **Verify connections** button performs read-only provider checks: it does not send an email, upload a file, create a Zoom meeting, or read student documents.

### Safe development delivery

External delivery is disabled by default whenever `NODE_ENV` is not `production`, even if a local `.env` contains real Resend, Twilio, WATI, or webhook credentials. This protects local previews and automated QA from accidentally contacting students or staff. Set `ALLOW_DEVELOPMENT_OUTBOUND_DELIVERY=true` only for a deliberate, isolated provider test; production delivery behavior is unchanged.

## Important safeguards

The browser never receives portal credentials. Enrollment number, reference number, date of birth, and board code are encrypted with AES-256-GCM in the server-side vault. Sync runs only after an explicit `consent: true` vault request. The system records audit entries, emits internal browser events, and only sends notifications for newly issued documents.

The local JSON repository is only a development datastore. The Supabase migration stores one encrypted application-state snapshot with optimistic revision checks; it is a safe bridge away from Render's ephemeral filesystem, not a substitute for a future normalized database model and managed job queue. Use a secret manager, object-storage retention policy, signed audit logs, backups, and a documented deletion/consent process before handling real student data.

### Moving an existing local state into Supabase

Do this only during a maintenance window and only if the local file contains data you are legally allowed to migrate. First make an encrypted offline backup, run the SQL migration, and configure the production variables above. The first successful Supabase-backed start initializes an empty production state only when `portal_state` has no row. It never overwrites an existing row.

If a deliberate one-time import is required, run the migration helper from a secure administrator machine (not the browser), with `PORTAL_STATE_IMPORT_FILE` pointing to the old `state.json`. The helper refuses to overwrite a non-empty destination and prints counts only, never student data. Rotate the local backup and securely delete it under your retention policy after verifying the live portal.

```powershell
$env:PORTAL_STATE_DRIVER = 'supabase'
$env:PORTAL_STATE_IMPORT_FILE = 'C:\secure-backup\state.json'
$env:IMPORT_PORTAL_STATE = 'confirm'
node scripts/migrate-local-state-to-supabase.mjs
```
