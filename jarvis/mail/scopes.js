// Full mailbox access is the owner's explicit decision. Narrowing it means changing this one line
// (and `jarvis-mail login` again), but read/send/delete all need it.
export const SCOPE = "https://mail.google.com/";

export const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export const KEYCHAIN = {
  account: "jarvis",
  clientId: "jarvis.gmail-client-id",
  clientSecret: "jarvis.gmail-client-secret",
  tokens: "jarvis.gmail-tokens", // JSON: { access_token, refresh_token, expires_at (ms epoch), scope }
};
