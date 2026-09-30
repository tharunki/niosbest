# TK's SOLUTION

TK's SOLUTION sells protected study PDFs for Class 10–12, JEE, NEET and future learning collections. It includes a secure admin area, a shared catalogue, Razorpay checkout, private time-limited downloads, and an automatically generated sitemap.

The recommended live deployment uses **Cloudflare Workers + D1** for the site, catalogue and orders, with private PDF storage in **Supabase Storage**. The Worker is the only component allowed to contact Supabase; students receive PDFs only through the protected download route. The legacy Node/Render server is retained only for local development and is **not approved for live paid sales**.

## Run locally

Use Node.js 24.

```powershell
$env:ADMIN_PASSWORD='a-private-password-of-at-least-12-characters'
$env:DOWNLOAD_TOKEN_SECRET='a-different-random-secret-of-at-least-32-characters'
npm start
```

Open `http://127.0.0.1:4173/`. Do not open the HTML files with `file://`; authentication, shared content and protected downloads need the server.

## Admin workflow

1. Go to `/admin.html` and sign in.
2. In **Library sections & tiles**, create or edit a top-level collection (for example JEE) and then its child tile (for example Formula Sheets). Publish the collection and tile when students should see them.
3. Upload a PDF to the protected library (maximum 25 MB).
4. Create a study card, choose its section or tile, add a free-text subject/topic, and choose the uploaded PDF. Save it as a draft until it is ready, then publish it.
5. Individual study cards are always ₹39. Tick **Full-course bundle** for ₹399; the server enforces both prices.
6. A published card has a working buy button only after it has a protected PDF selected and Razorpay has been configured.

Uploaded PDFs are never served as public static files. They are released only after a verified payment through a signed link that expires after 24 hours.

## Cloudflare deployment (recommended)

This is the version to use for a low-cost launch. The Worker source is in `cloudflare/worker.mjs`; apply every migration in `cloudflare/migrations/` in order. The deployed site must use the contents of `build/` as Cloudflare static assets. The PDF bucket is named `tks-papers` and must remain **private**: do not add a public Storage policy, a public bucket URL, or direct PDF links to the website.

1. Install a normal Node.js LTS distribution that includes `npm` and `npx` (the portable Node runtime bundled with some desktop tools does not include them).
2. Sign in to Cloudflare in a terminal with `npx wrangler login`.
3. From this folder, create the database:

   ```powershell
   npx wrangler d1 create best-education-db
   ```

4. Copy the D1 `database_id` printed by that command into `wrangler.jsonc`. Do not add passwords, payment keys, PDFs or database files to Git.
5. Create a Supabase project, then use its **Project URL** and server-side **Secret key** (the current key starts with `sb_secret_`). Do not use the anonymous/publishable key. Put both values into Cloudflare Worker secrets; never put the secret key in browser code, a static file, or Git.
6. Create the schema and server-only Worker secrets:

   ```powershell
   npx wrangler d1 migrations apply best-education-db --remote
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler secret put DOWNLOAD_TOKEN_SECRET
   npx wrangler secret put SUPABASE_URL
   npx wrangler secret put SUPABASE_SECRET_KEY
   npx wrangler secret put RAZORPAY_KEY_ID
   npx wrangler secret put RAZORPAY_KEY_SECRET
   npx wrangler secret put RAZORPAY_WEBHOOK_SECRET
   npx wrangler secret put PAYMENTS_ENABLED
   ```

   Use a unique admin password of at least 12 characters and a separate random download secret of at least 32 characters. Enter the Supabase Project URL for `SUPABASE_URL` and the Supabase Secret key for `SUPABASE_SECRET_KEY`. The Worker creates and verifies the private `tks-papers` bucket when an authenticated admin first opens the PDF library, restricting it to PDFs up to 25 MB. If you create it manually, keep it private; the Worker repairs the PDF/size restriction before an upload. Start with Razorpay **Test** keys. Enter `false` for `PAYMENTS_ENABLED` while setting up the site: PDFs stay visible as “coming soon” and cannot be bought until this deliberate sales switch is changed to `true`.

7. Deploy with `npx wrangler deploy`. Test browsing and admin access on the temporary `workers.dev` address first. It is deliberately marked `noindex`, so it will not compete with the final site in search results; it also deliberately rejects checkout, payment recovery and protected downloads. Test a real payment only on the final custom domain.
8. After testing the admin upload, a test purchase, a verified download, and the Razorpay webhook, attach the final custom domain and replace test Razorpay credentials with Live credentials. Set the webhook endpoint to:

   ```text
   https://YOUR-FINAL-DOMAIN/api/payment/webhook
   ```

   Subscribe Razorpay to `payment.captured` and `payment.failed`. Test one final purchase and download with the Live configuration, then set `PAYMENTS_ENABLED` to `true` **last**. This switch controls the public buy buttons, product indexing and checkout, so leaving it absent or `false` keeps sales safely closed.

Cloudflare Workers/D1 and Supabase Free are suitable for a small launch, but their allowances and inactivity rules can change. Monitor the two dashboards, keep source PDFs under the 25 MB upload limit, and plan an upgrade before heavy download traffic. The free Worker upload route is suitable for the current chapter PDFs; test large bundle PDFs before publishing them.

### Safe setup state

Before both Supabase Worker secrets are set, the catalogue and protected admin area can still be deployed and checked. PDF upload, paid checkout, and downloads deliberately show an unavailable message. This is intentional: do **not** work around it by publishing storage URLs, making the bucket public, or adding direct PDF links.

The Worker streams each purchased PDF from the private bucket only after it rechecks the signed download, order, refund/revocation, and expiry rules. A student never receives a permanent Supabase URL.

## Legacy Node / Render fallback

`server.mjs` and `render.yaml` are retained only to support local development and non-payment previews. The legacy server now rejects checkout, payment verification, webhooks and protected downloads even if old payment secrets remain configured. Do **not** deploy it for live paid sales, attach Razorpay Live credentials, upload paid PDFs, or point the production domain at it. The Cloudflare Worker is the production path because it includes persistent admin sessions, payment recovery, protected-file change guards, server-side filtering, checkout throttling, and per-paper SEO.

If you later need a Render-based paid deployment, backport and test those protections before using it. Keep the repository private and continue to exclude `papers/`, database files, and secrets from Git.

## Checks

```powershell
npm run check
npm run test:catalog
```

The health endpoint is available at `/healthz`.
