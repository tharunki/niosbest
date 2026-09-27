# Best Education

Best Education sells protected study PDFs for Classes 10, 11 and 12. It includes a secure admin area, a shared catalogue, Razorpay checkout, private time-limited downloads, and an automatically generated sitemap.

The recommended live deployment is the **Cloudflare free tier**: static pages are served from Cloudflare's edge, the shared catalogue and orders live in D1, and PDFs are stored in a private R2 bucket. The legacy Node/Render version remains available as a paid-hosting alternative.

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
2. Upload a PDF to the protected library (maximum 25 MB).
3. Create a study card and choose that uploaded PDF.
4. Use ₹39 for an individual lesson. Tick **Full-course bundle** and use ₹399 for a bundle.
5. A card has a working buy button only after it has a protected PDF selected and Razorpay has been configured.

Uploaded PDFs are never served as public static files. They are released only after a verified payment through a signed link that expires after 24 hours.

## Cloudflare deployment (recommended)

This is the version to use for a low-cost launch. The Worker source is in `cloudflare/worker.mjs`; its database migration is in `cloudflare/migrations/0001_initial.sql`. The deployed site must use the contents of `build/` as Cloudflare static assets. Do **not** make the R2 bucket public and do not enable an `r2.dev` public URL for the PDF bucket.

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

## Render deployment

`render.yaml` creates a paid Render Web Service with a 1 GB disk mounted at `/var/data`. It is deliberately a Web Service, not a Static Site.

Before deploying, create a **private** Git repository. The `.gitignore` intentionally excludes `papers/`, databases, and secrets so paid PDFs cannot be exposed through the repository. After the first deployment, upload PDFs through `/admin.html`; they are stored on the Render disk.

In Render set these private environment values:

- `SITE_URL` — your final HTTPS address, for example `https://www.ravitestpapers.in`
- `ADMIN_PASSWORD` — a unique password of at least 12 characters
- `DOWNLOAD_TOKEN_SECRET` — a separate random secret of at least 32 characters
- `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` — Test keys first, then Live keys
- `RAZORPAY_WEBHOOK_SECRET` — the secret generated when you create the Razorpay webhook

Configure Razorpay to call:

```text
https://YOUR-DOMAIN/api/payment/webhook
```

Subscribe it to `payment.captured` and `payment.failed`. The server records Razorpay orders in SQLite and verifies both the checkout signature and captured payment before it supplies a PDF.

The Render disk is required: databases and uploaded PDFs must live under `/var/data` so they remain after a deploy. Do not scale this disk-backed service to more than one instance.

## Checks

```powershell
npm run check
```

The health endpoint is available at `/healthz`.
