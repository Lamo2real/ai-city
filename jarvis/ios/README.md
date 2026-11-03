# Jarvis for iPhone

A small iPhone app. Hold the big button and talk to Jarvis; you hear the answer and can read it. It also answers "Hey Siri, Ask Jarvis".
The phone talks to your Mac over Tailscale, so it works away from home too. Nothing goes through anyone else's server.

## What you need
- A Mac with Xcode (free, from the App Store) and an iPhone on iOS 17 or newer.
- Your Apple ID (a free one is fine).
- A free Tailscale account, the same one on the Mac and the iPhone.

## Set it up

### 1. Put the app on your iPhone
1. Install **Xcode** from the App Store. Open it once and let it finish installing extras.
2. Xcode → **Settings → Accounts** → **+** → Apple ID. Sign in with your Apple ID.
3. Open `jarvis/ios/JarvisPhone.xcodeproj` (double-click it).
4. Click **JarvisPhone** (blue icon, top of the left list) → **Signing & Capabilities** → **Team** → pick your **Personal Team**.
   If Xcode says the bundle identifier `se.lamo.jarvis.phone` is taken, change it to something unique, such as `se.lamo.jarvis.phone2`.
5. On the iPhone: **Settings → Privacy & Security → Developer Mode** → on. The phone restarts. Confirm when asked.
6. Connect the iPhone to the Mac with a cable. Tap **Trust** on the phone if asked.
7. At the top of Xcode, choose your iPhone as the destination, then press **Run** (▶).
8. First launch only: on the iPhone open **Settings → General → VPN & Device Management**, tap your Apple ID under "Developer App", tap **Trust**. Then open the app again.
   (Optional later: Xcode → Window → Devices and Simulators → tick "Connect via network" to run over Wi-Fi.)

### 2. Connect the Mac and the iPhone
1. Install **Tailscale** on the Mac and on the iPhone (App Store) and sign in with the same account on both.
2. On the Mac, in the `jarvis` folder:
   ```
   scripts/enable-tailscale.sh
   scripts/pair-iphone.sh
   ```
   The second one shows a QR code (and prints a `jarvis-pair://…` line).
3. In the Jarvis app on the iPhone tap **Scan QR code** and allow the camera. No camera, or you'd rather not? Copy the `jarvis-pair://…` line, paste it into the app and tap **Pair**.
4. The dot at the top of the chat turns green when your Mac is reachable.

### 3. Use it
- **Talk:** hold the big button, speak, let go. What you say shows while you hold. Jarvis answers in text and out loud. Starting to talk silences Jarvis.
- **Type:** use the box under the button.
- **Mute:** the speaker icon at the top. The menu (•••) switches between English and Svenska for what you say, and lets you pair again.
- **Siri:** after you have opened the app once, say "Hey Siri, Ask Jarvis", then your question. Siri reads the answer. You can also find "Ask Jarvis" in the Shortcuts app. The phone must be unlocked: if it is locked, Siri first asks for Face ID or your passcode, so nobody within earshot of a locked phone can reach Jarvis.
- Jarvis can speak first (results, questions) while the app is open.

## Limits of a free Apple account
- The app **expires after 7 days**. When it stops opening, connect the iPhone to the Mac, open the project in Xcode and press Run again. Your pairing is kept.
- Max **3 apps** from a free account on one device.
- Siri and Shortcuts only know "Ask Jarvis" after the app has been opened once. Siri gives up on a slow answer after a short while; ask in the app for long jobs.
- While the app is closed, Jarvis can't speak to you first (iOS doesn't allow it without paid push services).

## Privacy
- The pairing secret is kept in the iPhone Keychain, only on this phone. It is never printed or stored elsewhere.
- Speech is turned into text on the phone when the phone supports it for that language.
- The app only talks to `https://<your-mac>.ts.net`, nothing else, and never over plain http.

## If something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| "Can't reach your Mac…" / red dot | Phone can't find the Mac | Tailscale on in both places? Mac awake (not asleep)? Same Tailscale account? Then tap **Check again**. |
| "This phone isn't paired…" or the pairing screen comes back | The Mac doesn't know this phone's secret | On the Mac run `scripts/pair-iphone.sh` again and scan the new code. |
| "That isn't a Tailscale name (.ts.net)" | The code is wrong or from the wrong place | Make a fresh code with `scripts/pair-iphone.sh`. Don't edit it by hand. |
| "Slow down" | Too many requests | Wait the number of seconds shown. |
| "Not allowed from the phone" | The Mac refuses that request from a phone | Expected for some actions. Do it on the Mac. |
| "Your Mac had a problem (error 5xx)" | Jarvis on the Mac failed | Check Jarvis on the Mac, then tap **Retry** under your message. |
| Message shows a red line with **Retry** | The send failed | Fix the cause (above), tap **Retry**. |
| "Jarvis can't hear you…" | Microphone or speech recognition is off | Tap **Open Settings** in the app, turn Microphone and Speech Recognition on. Typing still works. |
| Camera black or "camera is off" | Camera permission is off | **Open Settings** → Camera on, or paste the code instead. |
| App won't open, "Untrusted Developer" | Profile not trusted yet | Settings → General → VPN & Device Management → Trust. |
| App stopped opening after about a week | Free account's 7 days are over | Connect, press Run in Xcode again. |
| Xcode: "Developer Mode disabled" | Step 5 missed | Turn on Developer Mode on the phone, restart it. |
| Xcode: "Failed to register bundle identifier" | Name is taken | Change the bundle identifier (step 4). |
| Xcode: "No account / no team" | Not signed in | Xcode → Settings → Accounts → add your Apple ID, pick the Personal Team. |
| Xcode: "maximum number of apps" | Free account allows 3 | Delete another Xcode-installed app from the phone. |
| Siri asks for Face ID or the passcode | The phone is locked; Jarvis can file real work, so it needs an unlocked phone | Unlock (Face ID) and ask again. This is on purpose. |
| "Hey Siri, Ask Jarvis" does nothing | Siri hasn't learned it | Open the app once, wait a minute, try again. Check Settings → Siri → Apps → Jarvis is on. |

## For developers
- `JarvisKit/` Swift package (Foundation + Security only): pairing, Keychain store, bridge client, parsers, typed errors. Builds on macOS and iOS.
- `JarvisPhone/` SwiftUI app sources (the Xcode project reads this folder automatically; new files appear without editing the project).
- `JarvisKit/Tests/` swift-testing tests. `JarvisKit/Checks/main.swift` the same checks as a plain program.
- `scripts/check.sh` runs everything possible on this Mac. With Xcode installed it also runs `swift test` and an iOS Simulator build.
- Bridge contract: `GET /api/app/v1/health`, `POST /api/app/v1/chat` (NDJSON), `GET /api/app/v1/events` (SSE), `Authorization: Bearer <token>`.
