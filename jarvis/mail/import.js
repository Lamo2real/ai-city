// `jarvis-mail setup --import`: reads the OAuth client JSON downloaded from the Google console,
// stores it in the Keychain and deletes the file, so the secret never sits in Downloads.
import { lstat, readFile, readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CODES, MailError } from "./errors.js";

const DOWNLOAD_RE = /^client_secret_.*\.apps\.googleusercontent\.com\.json$/;
const bad = (m) => new MailError(CODES.BAD_REQUEST, m);

async function newestDownload(dir) {
  let names;
  try { names = (await readdir(dir)).filter((n) => DOWNLOAD_RE.test(n)); } catch { names = []; }
  const dated = [];
  for (const n of names) {
    const st = await lstat(join(dir, n)).catch(() => null);
    if (st?.isFile()) dated.push({ path: join(dir, n), mtime: st.mtimeMs });
  }
  if (!dated.length) throw bad(`No client_secret_*.apps.googleusercontent.com.json found in ${dir}. Download the JSON from the Google console, or pass its path.`);
  return dated.sort((a, b) => b.mtime - a.mtime)[0].path;
}

export function parseClientJson(text) {
  let json;
  try { json = JSON.parse(text); } catch { throw bad("That file is not valid JSON, so it was left in place. Download the OAuth client JSON again."); }
  if (json?.web) throw bad('This is a "Web application" client. Create a client of type "Desktop app" in the Google console and download that JSON.');
  const c = json?.installed;
  if (!c || typeof c.client_id !== "string" || typeof c.client_secret !== "string" || typeof c.auth_uri !== "string" || typeof c.token_uri !== "string") {
    throw bad('That file is not a Desktop-app OAuth client (expected an "installed" section with client_id, client_secret, auth_uri and token_uri).');
  }
  return { clientId: c.client_id, clientSecret: c.client_secret };
}

export async function importClient({ path, store, downloadsDir = join(homedir(), "Downloads") }) {
  const file = path || (await newestDownload(downloadsDir));
  const st = await lstat(file).catch(() => null);
  if (!st) throw bad(`There is no file at ${file}.`);
  if (!st.isFile()) throw bad(`${file} is not a regular file.`);
  const { clientId, clientSecret } = parseClientJson(await readFile(file, "utf8"));
  try {
    await store.setCredentials(clientId, clientSecret);
  } catch (err) {
    throw bad(`${err.message} The file was left in place.`);
  }
  let deleted = true;
  try { await unlink(file); } catch { deleted = false; }
  return { ok: true, client_id: `${clientId.slice(0, 6)}…`, file_deleted: deleted, ...(deleted ? {} : { warning: `Saved, but could not delete ${file}. Delete it yourself: it contains the client secret.` }) };
}
