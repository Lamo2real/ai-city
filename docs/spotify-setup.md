# Spotify: owner setup (about five minutes, once)

Jarvis controls Spotify through the Spotify Web API: search, play, pause, skip, seek, volume, shuffle, repeat, queue, devices, playlists and your library. You do the three steps below yourself. Jarvis never sees your Spotify password: you type it only on Spotify's own page in your browser.

**You need:** Spotify **Premium**. Spotify requires it for playback control, and since February 2026 the owner of a development-mode app must have Premium for the app to work at all.

## 1. Create the app (developer.spotify.com)

1. Open <https://developer.spotify.com/dashboard> and log in with your normal Spotify account.
2. **Create app**:
   - App name: `Jarvis` (any name works). Description: `Personal assistant`.
   - Redirect URI: enter **exactly** `http://127.0.0.1:8975/callback` and click **Add**.
     It must be `127.0.0.1`, not `localhost` (Spotify rejects `localhost`), and `http` is correct here because it's a loopback address.
   - Under "Which API/SDKs are you planning to use?" tick **Web API**.
   - Accept the terms and click **Save**.
3. Open the app's **Settings** and copy the **Client ID**. You don't need the Client secret: Jarvis uses PKCE and never stores one.

## 2. Give Jarvis the Client ID

In Terminal, from the ai-city repo:

```bash
jarvis/bin/jarvis-spotify setup
```

Paste the Client ID at the `Spotify Client ID:` prompt. It's stored in the macOS Keychain (item `jarvis.spotify-client-id`), not in any file.

## 3. Sign in and approve

```bash
jarvis/bin/jarvis-spotify login
```

Your browser opens Spotify's consent page. Check the permissions and click **Agree**. The tab then says "Signed in" and you can close it. The tokens go into the Keychain (item `jarvis.spotify-tokens`) and refresh by themselves. Check it worked:

```bash
jarvis/bin/jarvis-spotify status
```

`login` and `status` also show your account type. Spotify stopped sending the account type to new apps in February 2026, so it often reads "unknown". In that case Jarvis tells you plainly the first time Spotify refuses a playback command for lack of Premium.

Then ask Jarvis: "play something by Daft Punk", "skip", "volume 40", "add this to my Gym playlist".

## Permissions Jarvis asks for

Full read and write access by default: playback state and control, currently playing, streaming, reading and editing your playlists (private, collaborative, public) and their cover images, reading and editing your library, recently played, top items, the artists you follow, and your account details. All of them are listed in one place, `jarvis/spotify/scopes.js`. To narrow access, delete lines there and run `login` again.

## Signing out and revoking access

- `jarvis/bin/jarvis-spotify logout` deletes the tokens from the Keychain.
- To revoke on Spotify's side too: <https://www.spotify.com/account/apps/> → Jarvis → **Remove access**. Jarvis then says it needs you to sign in again.

## DJ

"Play DJ" works on a best-effort basis. Spotify has **no documented Web API for DJ**. Jarvis tries, in order:

1. Starting DJ's context (`spotify:playlist:37i9dQZF1EYkqdzj48dyYq`) on your Mac through the Web API, then checking that it is really playing.
2. Asking the Spotify desktop app on your Mac to play the same URI through AppleScript, then checking again.
3. If neither is confirmed, Jarvis says so plainly and asks you to tap **DJ** in the Spotify app. After that, Jarvis can pause, skip and change the volume as usual.

Developers report that route 1 often just stops playback instead. Spotify may change this at any time. DJ must also be available for your account and country. While DJ is talking, "what's playing" may have no track to report.

## Limits worth knowing

- **Development mode** (where every new app starts): only the app owner's Premium account and at most 5 allow-listed users can use the app, and one Client ID per developer. That's fine for personal use. You don't need to apply for extended quota.
- Search returns at most 10 results per request (Spotify's limit since February 2026).
- Spotify-owned editorial and algorithmic playlists (e.g. "Today's Top Hits", Daily Mix) can be played but may not be readable through the API. Jarvis can't list their tracks.
- Playback control needs an active Spotify device. If none is active, Jarvis opens Spotify on your Mac and moves playback there.
- Without sign-in, or without Premium, Jarvis still has the old AppleScript control for basic play, pause, skip, volume and now playing on the Mac app. Search, playlists and library need the Web API.

## Troubleshooting

| Jarvis says | Do this |
|---|---|
| "Spotify isn't set up" | Run step 2. |
| "Sign in again" | Run step 3. This happens after you revoke access, change scopes or change your password. |
| "INVALID_CLIENT: Invalid redirect URI" in the browser | The dashboard's redirect URI must be exactly `http://127.0.0.1:8975/callback`. |
| "Playback control needs Spotify Premium" | Playback via the Web API needs Premium. Basic AppleScript control still works. |
| "User not registered in the Developer Dashboard" | The signed-in account isn't the app owner or an allow-listed user: dashboard → app → **User Management**. |
| "Rate limited" | Spotify asked Jarvis to wait. Try again shortly. |
