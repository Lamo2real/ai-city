// Generic macOS Keychain access through /usr/bin/security. Values never go in argv.
import { execFile } from "node:child_process";

const ACCOUNT = "jarvis";

function runSecurity(args, { input } = {}) {
  return new Promise((resolve) => {
    const child = execFile("/usr/bin/security", args, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

// `security -i` reads commands from stdin: double quotes, backslash escapes.
function quote(value) {
  if (/[\r\n\0]/.test(value)) throw new Error("Keychain value must not contain control characters.");
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

export function createKeychain({ run = runSecurity } = {}) {
  return {
    async get(service) {
      const r = await run(["find-generic-password", "-a", ACCOUNT, "-s", service, "-w"]);
      if (r.code === 44 || /could not be found/i.test(r.stderr || "")) return null;
      if (r.code !== 0) throw new Error(`Keychain read failed for ${service} (exit ${r.code}).`);
      return r.stdout.replace(/\n$/, "");
    },
    async set(service, value) {
      const r = await run(["-i"], { input: `add-generic-password -U -a ${ACCOUNT} -s ${service} -w ${quote(value)}\n` });
      if (r.code !== 0 || /security:|error/i.test(r.stderr || "")) throw new Error(`Keychain write failed for ${service} (exit ${r.code}).`);
    },
    async remove(service) {
      const r = await run(["delete-generic-password", "-a", ACCOUNT, "-s", service]);
      if (r.code !== 0 && r.code !== 44) throw new Error(`Keychain delete failed for ${service} (exit ${r.code}).`);
    },
  };
}
