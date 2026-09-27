# Academy E2E and security regression tests

Run against a disposable, separately configured staging deployment. Never use real student documents or enable mutation tests on production. Tests do not automatically start the application, charge payments, send mail or create Zoom meetings.

## Setup (PowerShell)

Install Node.js with npm, then open this directory:

    npm install
    npx playwright install chromium
    $env:E2E_BASE_URL = 'http://localhost:3000'
    npm test

For authenticated coverage, supply dedicated staging accounts through environment variables or a CI secret store:

- E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD
- E2E_TEACHER_EMAIL / E2E_TEACHER_PASSWORD
- E2E_STUDENT_EMAIL / E2E_STUDENT_PASSWORD (paid, active, batch A)
- E2E_OTHER_BATCH_MATERIAL_ID (existing batch B material)
- E2E_OWN_DOCUMENT_ID (existing document owned by test student)
- E2E_PRIVATE_OBJECT_PUBLIC_URL (public URL corresponding to that existing private object)
- E2E_ALLOW_MUTATIONS=yes enables draft batch creation/edit/readback/cleanup.

Missing authenticated fixtures fail explicitly; they are not counted as passes. Mutations are skipped unless explicitly enabled.

For deployment security:

    $env:E2E_BASE_URL = 'https://your-staging-domain.example'
    npm run test:security
    npm run report

Both desktop Chrome and mobile Chromium viewport/touch emulation run. This is not physical iOS/Safari validation. Do not upload reports publicly. No test prints credentials; screenshots, videos and traces are disabled.

## Coverage and release checklist

- [ ] Public pages load, internal links resolve, no unexpected console errors/404/5xx, no horizontal overflow.
- [ ] All three resource sections change class independently and respect search/board filters.
- [ ] Quick checklist download produces a file; resource navigation preserves the authentication gate.
- [ ] Login/signup controls and rejected credentials display the expected state.
- [ ] Admin batch fields round-trip through the real API; draft remains unpublished.
- [ ] Anonymous/student/teacher access restrictions hold at API level, including forged sessionStorage roles.
- [ ] Other-batch material access is denied.
- [ ] HTTPS deployment has valid certificates, no HTTP requests, HttpOnly/Secure/Strict session cookie.
- [ ] Client storage contains no passwords, DOB/enrollment details, OAuth tokens or service secrets.
- [ ] Public HTML/scripts/API payloads contain no recognizable provider secrets.
- [ ] A real owned document downloads for its owner but not anonymously; its cloud object is not publicly readable.

## Remaining workflow scenarios (not yet automated)

The generated interaction inventory is not proof that every button works. Add explicit expected-action tests for every remaining control before signing off the entire website:

1. New account → batch selection → subjects → required synthetic document upload → email outbox capture → payment sandbox success → paid pending dashboard → admin manual verification → active dashboard.
2. Cancelled/failed/tampered and replayed payment events must not grant access; verify amount, currency and webhook signature.
3. Teacher schedules a batch-A class; batch-B student cannot list or join it. Verify join opens exactly 10 minutes before start and closes at end; no Zoom host token appears in student payloads.
4. Teacher uploads synthetic material/homework → eligible student submits → teacher grades → student sees feedback. Test cross-batch and other-student object IDs.
5. Oversized, disguised, malicious and unsupported uploads fail safely; signed links (if introduced later) expire and cannot be replayed after expiry.
6. Verify document-owner isolation, CSRF protection, rate limits, logout invalidation, HSTS and safe redirect handling.
7. Inspect authenticated API responses for leaked provider keys as well as public payloads.

Current implementation uses an authenticated file proxy, not browser-visible signed storage links. Encryption at rest cannot be proven by a browser test: separately inspect vault cryptography, key management and cloud storage settings. Client-side encryption with a browser-delivered key is not a substitute for keeping secrets off the client.

The server uses `SameSite=Strict` and `Secure` session cookies in production. Local HTTP is for development only and cannot pass the production TLS test.
