# Gmail: owner setup (about ten minutes, once)

`jarvis-mail` gives Jarvis **full access to your Gmail**: read, search, label, archive, trash, delete permanently, draft, send, reply and forward. That is your decision, and it is the broadest Gmail permission there is (`https://mail.google.com/`). You do the steps below yourself. Jarvis never sees your Google password or 2-step codes: you sign in only on Google's own page, in your browser.

**Read this first:** once you finish, Jarvis on **all** its channels, including Telegram, can read and send your mail when asked. Email content is treated as data and never as an instruction, but treat the channels you give Jarvis as keys to your inbox. Every send, reply, forward, send-draft, trash and delete is logged (no message text, no tokens) to `~/Library/Application Support/Jarvis/access-audit.jsonl`.

## 1. Create the Google Cloud project

1. Open <https://console.cloud.google.com/> and sign in with the Google account whose mail Jarvis should use.
2. Create a new project (name it `Jarvis`).
3. **APIs & Services → Library**, search for **Gmail API**, and click **Enable**.

## 2. OAuth consent screen

1. **APIs & Services → OAuth consent screen** (Google may call this "Google Auth Platform").
2. User type: **External**. App name `Jarvis`, your email as support and developer contact.
3. Scopes: add `https://mail.google.com/`.
4. Publishing status: click **Publish app** so it says **In production**. Do **not** leave it on Testing: Google ends sign-in for Testing apps after 7 days. Skip Google's verification: for your own use you do not need it.

## 3. Create the OAuth client

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Desktop app**. Name: `Jarvis`.
3. Click **Download JSON** on the new client (it lands in `~/Downloads` as `client_secret_….json`). For a Desktop app Google expects the secret in the sign-in exchange, so Jarvis stores the client ID and secret in the macOS Keychain.

## 4. Give Jarvis the client, then sign in

In Terminal, from the ai-city repo. (`setup --import <path>` takes a specific file. Without the JSON, plain `jarvis-mail setup` asks for the Client ID and, hidden, the secret.)

```
jarvis/bin/jarvis-mail setup --import   # reads the newest client_secret_*.json in ~/Downloads, stores it in the Keychain, deletes the file
jarvis/bin/jarvis-mail login     # your browser opens Google
```

In the browser, choose your account. Google shows **"Google hasn't verified this app"** once: that is expected, because you did not submit the app for Google's verification. Click **Advanced → Go to Jarvis (unsafe)**, tick every permission, and continue. The page then says "Signed in, you can close this tab." The sign-in lasts, and Jarvis refreshes it by itself.

Check it:

```
jarvis/bin/jarvis-mail status
jarvis/bin/jarvis-mail list --limit 5
```

If `jarvis-mail` is not on your PATH, use the full path as above. Jarvis finds it on its own.

## Things to know

- **Unverified, In production:** Google caps unverified apps that use restricted scopes at 100 users. That does not matter for personal use, since the only user is you.
- **Testing mode (only if you chose it):** Google ends the sign-in after 7 days. `jarvis-mail` then says access expired: run `jarvis-mail login` again. Publishing the app avoids this.
- **If access is revoked or expires:** `jarvis-mail` says so in plain words. Run `jarvis-mail login` and approve again.
- **No refresh token returned:** if login says so, remove Jarvis in your Google account (below) and run `login` again.
- **Attachments are listed, not downloaded or forwarded.** A forward carries the text only and says how many attachments were left out.
- **Replies** keep the thread and the right `In-Reply-To` / `References` headers but do not quote the original.

## Who Jarvis may email without asking

Everything works without asking **except sending** (send, reply, forward, send-draft) to **business** recipients. For each To, Cc and Bcc address, in this order:

1. Your own addresses (your account and its send-as aliases): sent.
2. Your **personal list**: sent.
3. Your **business list**: held.
4. A company or custom domain (anything that isn't Gmail, iCloud, Outlook/Hotmail/Live, Yahoo, Proton, GMX, AOL and similar): held. A consumer address is held too when the thread or the draft reads like business (invoice, contract, quote, offer, a title like CEO, a company suffix like AB, Ltd or Inc).
5. Not sure: held.

If anything is held, nothing is sent. Jarvis tells you the draft in plain words (who, subject, the first lines, and why it was held) and asks you to reply **"I confirm the email"** to send it, or **"Cancel the email"**.

- **Only you can approve.** The Jarvis server watches for your own message, exactly that phrase, on the HUD, by voice, in the Jarvis app or on Telegram (not on the plain-HTTP LAN page). The model and `jarvis-mail` cannot approve: there is no command or flag for it. An approval is for that exact draft (change a word and it needs a new one), works once, and lapses after 30 minutes. Only one email waits at a time: a newer one replaces the older.
- **Jarvis must be running.** `jarvis-mail` asks the local server for the approval; if the server is down, a business send is not made.
- `jarvis-mail setup` creates the token (Keychain item `jarvis.mail-gate`) that lets `jarvis-mail` talk to the server's approval endpoints.
- Lists: `jarvis-mail contacts list`, `contacts add <email|@domain> --personal|--business`, `contacts remove <email|@domain>`. Stored in `~/Library/Application Support/Jarvis/mail-contacts.json`. Tell Jarvis "treat mum@yahoo.se as personal" and it adds it. Be careful with `--personal` for company addresses: it switches the check off for them.
- Every send is logged with recipients, subject, which approval was used (`confirmation_used`) and the channel it came from. Never the message text.

## Revoking access

- On this Mac: `jarvis-mail logout` deletes the saved tokens. (Client ID and secret stay until you remove `jarvis.gmail-client-id` and `jarvis.gmail-client-secret` in Keychain Access.)
- At Google, which is the real off switch: <https://myaccount.google.com/> → **Security → Third-party access** (or "Your connections to third-party apps and services") → **Jarvis → Remove access**. You can also delete the OAuth client in the Cloud console.
