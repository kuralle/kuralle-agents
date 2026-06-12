# Meta / WhatsApp Cloud API account setup

The walkthrough for getting from "I have a Meta account" to "I have the five credentials and a webhook that verifies." Meta's UI shifts around, so trust the *structure* (App → WhatsApp product → API Setup) more than exact button labels, and tell the user when something looks different.

## 1. Create the app

1. Go to **developers.facebook.com → My Apps → Create App**.
2. Pick use case **"Other"** → app type **"Business"** (this is what exposes WhatsApp). Name it, attach a Business Portfolio (or create one).
3. In the app dashboard, find **WhatsApp** in the product list → **Set up**.

You're now in **WhatsApp → API Setup**. This one screen has most of what you need.

## 2. Grab the credentials (WhatsApp → API Setup)

- **Temporary access token** — a button at the top. Copy it. ⚠️ **Expires in ~24 hours.** Fine for first tests; replace before anything real (see §5).
- **Phone number ID** — listed under "From". This is `WHATSAPP_PHONE_NUMBER_ID`. It is a long number, *not* the +1… phone number.
- **WhatsApp Business Account ID (WABA ID)** — also shown here. This is `WHATSAPP_WABA_ID` (only needed for templates).

For the **app secret**: **App Settings → Basic → App Secret → Show**. This is `WHATSAPP_APP_SECRET`.

For the **verify token**: you make it up. Any string (e.g. `my-bot-verify-7f3a`). You'll paste the same value into the webhook screen. This is `WHATSAPP_VERIFY_TOKEN`.

Validate before you build anything:

```bash
curl -s "https://graph.facebook.com/v24.0/<PHONE_NUMBER_ID>?fields=verified_name,display_phone_number&access_token=<ACCESS_TOKEN>"
```

A JSON object with `verified_name` + `display_phone_number` = the token and phone id are both good. An error here saves you from chasing phantom deploy bugs.

## 3. Add yourself as a test recipient

While the app is unpublished, Meta delivers **only** from numbers on the tester list.

- WhatsApp → API Setup → **"To"** → **Manage phone number list** → add your phone. You'll confirm via a code WhatsApp sends you.
- Up to 5 test recipients.

This is what lets you message the test number and get a reply without publishing.

## 4. Configure the webhook

Do this *after* the bot is deployed and the URL is reachable.

- WhatsApp → **Configuration → Webhook → Edit**.
- **Callback URL**: `https://<your-host>/messaging/whatsapp/webhook`
- **Verify token**: the exact `WHATSAPP_VERIFY_TOKEN` value.
- **Verify and save** — Meta sends `GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…` and expects the challenge echoed back. The deploy templates implement this; it turns green instantly if the token matches.
- **Manage webhook fields → subscribe to `messages`** (and `message_template_status_update` if you use templates).

The orange "Apps will only receive test webhooks while unpublished" banner is normal — it means real-number delivery needs either a tester (above) or a published app (below).

## 5. Get a permanent token (do this before production)

The temp token dying after 24h is the single most common "it stopped working" cause. Replace it:

1. **Business Settings** (business.facebook.com/settings) → **Users → System Users → Add** → make an Admin system user.
2. **Generate new token** → select your app → set token expiration to **Never** → tick `whatsapp_business_messaging` **and** `whatsapp_business_management`.
3. Copy it and update your host secret:
   ```bash
   echo "<system-user-token>" | npx wrangler secret put WHATSAPP_ACCESS_TOKEN   # CF
   fly secrets set WHATSAPP_ACCESS_TOKEN=<system-user-token>                    # Fly
   ```

## 6. Publishing (only to open the bot to the public)

For a demo to known phones, **skip this** — test recipients are enough. To let anyone message it:

1. **App Settings → Basic**: add a **Privacy Policy URL** (required), a **1024×1024 app icon**, a **Category**, and a contact email.
2. **Business Verification**: Business Settings → Security Center (or you'll be prompted). Verify the business with documents (registration / utility bill / etc.). This can take hours to days — it's the real gate.
3. **Permissions**: App Review → ensure `whatsapp_business_messaging` + `whatsapp_business_management` have the access level you need. Basic Cloud API messaging usually doesn't require a full review submission once business verification passes.
4. **Flip App Mode → Live** at the top of the app dashboard (this is the "Publish your app" link).

### Need a Privacy Policy URL fast?

You can serve a simple page from the same host as the bot (a static `public/privacy.html` on Cloudflare/Vercel, or a route on Fly). It needs to be a real, reachable URL describing what data you collect (WhatsApp messages, phone number, any images), the third-party processors (Meta, your model provider, your host), retention, and a contact. Keep it honest; for a demo, clearly label it a demonstration service.

### Need a 1024×1024 app icon fast?

A clean vector mark beats an AI raster at icon sizes (no text artifacts, sharp when shrunk). Write an SVG, then rasterize to PNG. If `libcairo`/`rsvg`/ImageMagick aren't installed, Chrome headless is the reliable fallback:

```bash
# wrap the svg in a zero-margin HTML page, then:
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1024,1024 --screenshot=icon-1024.png "file://$PWD/icon.html"
```

(Don't screenshot the `<svg>` element via a browser-automation selector — it tends to letterbox the image. Render the full window instead.)
