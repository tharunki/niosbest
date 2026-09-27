# Best Education

Best Education is a Node.js website for selling protected study PDFs. It includes a secure admin area, a shared SQLite catalogue, Razorpay checkout preparation, time-limited downloads, and an automatically generated sitemap.

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

## Render deployment

`render.yaml` creates a paid Render Web Service with a 1 GB disk mounted at `/var/data`. It is deliberately a Web Service, not a Static Site.

Before deploying, create a **private** Git repository. The `.gitignore` intentionally excludes `papers/`, databases, and secrets so paid PDFs cannot be exposed through the repository. After the first deployment, upload PDFs through `/admin.html`; they are stored on the Render disk.

In Render set these private environment values:

- `SITE_URL` — your final HTTPS address, for example `https://www.besteducation.in`
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
