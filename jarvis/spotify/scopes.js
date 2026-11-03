// The one place Jarvis's Spotify permissions live. Narrow access by deleting lines here,
// then run `jarvis-spotify login` again so Spotify asks the owner for the new set.
export const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "streaming",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
  "user-library-read",
  "user-library-modify",
  "user-read-recently-played",
  "user-top-read",
  "user-follow-read",
  "user-follow-modify",
  "user-read-private", // account type (GET /me product), when Spotify still returns it
  "ugc-image-upload", // playlist cover images
];

// Register exactly this in the Spotify dashboard. Spotify rejects "localhost"; HTTP is allowed only for loopback IPs.
export const REDIRECT_PORT = 8975;
export const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

export const KEYCHAIN = {
  account: "jarvis",
  clientId: "jarvis.spotify-client-id",
  tokens: "jarvis.spotify-tokens", // JSON: { access_token, refresh_token, expires_at (ms epoch), scope }
};

// Spotify DJ's context. Not a documented Web API feature: see docs/spotify-setup.md → "DJ".
export const DJ_URI = "spotify:playlist:37i9dQZF1EYkqdzj48dyYq";
