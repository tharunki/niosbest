# TK's SOLUTION

TK's SOLUTION sells protected study PDFs for Class 10–12, JEE, NEET and future learning collections. It includes a secure admin area, a shared catalogue, Razorpay checkout, private time-limited downloads, and an automatically generated sitemap.

The recommended live deployment is the **Cloudflare free tier**: static pages are served from Cloudflare's edge, the shared catalogue and orders live in D1, and PDFs are stored in a private R2 bucket. The legacy Node/Render server is retained only for local development and is **not approved for live paid sales**.

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

This is the version to use for a low-cost launch. The Worker source is in `cloudflare/worker.mjs`; apply every migration in `cloudflare/migrations/` in order. The deployed site must use the contents of `build/` as Cloudflare static assets. Do **not** make the R2 bucket public and do not enable an `r2.dev` public URL for the PDF bucket.

1. Install a normal Node.js LTS distribution that includes `npm` and `npx` (the portable Node runtime bundled with some desktop tools does not include them).
2. Sign in to Cloudflare in a terminal with `npx wrangler login`.
3. From this folder, create the private storage resources:

   ```powershell
   npx wrangler d1 create best-education-db
   npx wrangler r2 bucket create best-education-papers
   ```

4. Copy the D1 `database_id` printed by the first command into `wrangler.jsonc`. Do not add passwords, payment keys, PDFs or database files to Git.
5. Create the schema and production secrets:

   ```powershell
   npx wrangler d1 migrations apply best-education-db --remote
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler secret put DOWNLOAD_TOKEN_SECRET
   npx wrangler secret put RAZORPAY_KEY_ID
   npx wrangler secret put RAZORPAY_KEY_SECRET
   npx wrangler secret put RAZORPAY_WEBHOOK_SECRET
   ```

   Use a unique admin password of at least 12 characters and a separate random download secret of at least 32 characters. Start with Razorpay **Test** keys.

6. Deploy with `npx wrangler deploy`. Test the temporary `workers.dev` address first. It is deliberately marked `noindex`, so it will not compete with the final site in search results.
7. After testing the admin upload, a test purchase, a verified download, and the Razorpay webhook, attach the final custom domain and replace test Razorpay credentials with Live credentials. Set the webhook endpoint to:

   ```text
   https://YOUR-FINAL-DOMAIN/api/payment/webhook
   ```

   Subscribe Razorpay to `payment.captured` and `payment.failed`.

The Workers, D1 and R2 included free allowances are generous for a new study-material site, but R2 is usage-billed after its free allowance and Cloudflare may require a billing profile/card even when monthly usage remains ₹0. Add a Cloudflare budget alert before opening sales. The free Worker upload route is suitable for the current chapter PDFs; upload very large bundle PDFs only after testing because Workers Free has a small CPU limit.

### Catalogue-only preview while R2 is pending

If the R2 activation page is still awaiting a billing profile, do **not** attach public PDF links or Razorpay credentials as a workaround. The project includes a safe temporary launch command instead:

```powershell
pnpm run cloudflare:catalog-preview
```

It deploys the shared catalogue, search, and protected admin area to the same `workers.dev` address without an R2 binding. Students can browse the library, while the admin can create sections and draft cards. PDF upload, paid checkout, and downloads deliberately show a clear unavailable message until private R2 storage is enabled. After activating R2, deploy the normal configuration with `pnpm run cloudflare:deploy`; it attaches the private `PAPERS` bucket without changing the public Worker URL. Because this preview uses the same Worker name, do not run the catalogue-preview command after R2 is live unless you deliberately want to disable the R2 binding and all purchases.

## Legacy Node / Render fallback

`server.mjs` and `render.yaml` are retained only to support local development and non-payment previews. Do **not** deploy them for live paid sales, attach Razorpay Live credentials, upload paid PDFs, or point the production domain at them. The Cloudflare Worker is the production path because it includes persistent admin sessions, payment recovery, protected-file change guards, server-side filtering, checkout throttling, and per-paper SEO.

If you later need a Render-based paid deployment, backport and test those protections before using it. Keep the repository private and continue to exclude `papers/`, database files, and secrets from Git.

## Checks

```powershell
npm run check
npm run test:catalog
```

The health endpoint is available at `/healthz`.
