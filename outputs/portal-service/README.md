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

The enforced order is: select a batch → sign in → select subjects offered by that batch’s class and stream, then submit identity proof, photo, signature, and previous academic proof → admin-email payload → full payment → restricted paid status → NIOS verification. Payment orders are rejected until the document application is submitted. `/dashboard` serves an explicit payment-pending screen before payment, then a restricted “Payment Received — Admission Application Pending Admin Processing” view after payment. Only a background sync response with `admissionConfirmed: true` moves a `VERIFICATION_IN_PROGRESS` application to `ACTIVE`; only then can it call materials, live-classes, homework, or download APIs. Those queries additionally filter on batch, board, class, stream, and selected subject code.

`/teacher-portal` schedules target-batch live classes, posts homework, uploads tagged material, and grades submissions. The live-class endpoint enables its join link only in the ten minutes before the scheduled start.

For a public site without an approved NIOS data connector, set `NIOS_SYNC_MODE=manual`. In this mode, sync never manufactures documents or confirms an application. After a paid student’s official NIOS record has been checked, an authenticated admin starts verification, then explicitly selects **Confirm official admission & unlock Desk**. This records the admin action in the audit log, notifies the student through the configured notification provider, and grants batch-isolated materials and live-class access. Do not use `mock` in production: it exists only to exercise the local development flow.

## Production configuration

The addresses `niosbest.tvl@gmail.com` and `tkcrackjee@gmail.com` are permanent protected super administrators. They cannot be demoted through the staff API. On a fresh production deployment, use one of them as `BOOTSTRAP_ADMIN_EMAIL` with a unique 12+ character server-only password. That owner can then open `/admin/staff` and send a single-use, 24-hour Resend invitation to the second owner and to teachers.

The owner controls can assign teachers to specific batches, allow or deny live-class scheduling, homework creation, material uploads and grading, suspend a teacher account, and restrict or restore individual online classes. These rules are enforced by the API, not only by the interface.

- Generate a new 32-byte key with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and set `APP_ENCRYPTION_KEY`.
- Use a fresh `PORTAL_STATE_DIR` for production; never deploy the local `.portal-data` directory. Set `BOOTSTRAP_ADMIN_EMAIL` and a unique 12+ character `BOOTSTRAP_ADMIN_PASSWORD` to create the first admin on the initial production start. Demo accounts are disabled in production and a startup check blocks any production state that contains them.
- Replace local storage with an S3-compatible bucket (`STORAGE_DRIVER=s3`) or Supabase Storage (`STORAGE_DRIVER=supabase`). For Supabase, `SUPABASE_SERVICE_ROLE_KEY` accepts either the modern server-only `sb_secret_...` key or a legacy `service_role` JWT. Stored documents remain private and are downloaded through this authenticated server endpoint.
- Choose `NOTIFICATION_PROVIDER=resend-email` to send student alerts through the configured Resend sender; or choose Twilio SMS/WhatsApp, WATI, or a generic webhook by setting the corresponding notification variables.
- Set `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET`. The browser uses Razorpay's hosted checkout; the server verifies the returned signature and independently accepts only HMAC-verified `payment.captured` webhooks. Never activate an enrollment from a client-only success page.
- Set `RESEND_API_KEY`, `ADMIN_ADMISSION_EMAIL`, and a verified `ADMISSION_EMAIL_FROM` for direct admin-inbox delivery; or use `ADMISSION_INTAKE_WEBHOOK_URL` for a trusted email/workflow bridge. The payload includes subject choices and protected document references; files remain in private storage and are downloaded only in the authenticated admin portal.
- Put an authorised server-to-server NIOS connector behind `OFFICIAL_NIOS_CONNECTOR_URL`; that connector must have written permission and perform the official authentication journey without defeating CAPTCHA, OTP, rate limits, or access controls.
- Protect the admin API with `ADMIN_API_TOKEN`; in production, add real authentication/authorization ahead of the API gateway.

## Important safeguards

The browser never receives portal credentials. Enrollment number, reference number, date of birth, and board code are encrypted with AES-256-GCM in the server-side vault. Sync runs only after an explicit `consent: true` vault request. The system records audit entries, emits internal browser events, and only sends notifications for newly issued documents.

The local JSON repository is only a development datastore. Use a managed encrypted database, secret manager, object-storage retention policy, signed audit logs, and a documented deletion/consent process before handling real student data.
