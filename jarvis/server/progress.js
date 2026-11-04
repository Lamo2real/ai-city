// What makes a reply feel live: split streamed text into sentences to speak as they
// arrive, and short spoken lines only when there is a real wait. Quick replies, like an
// answer to a greeting, get none. The lines say what is actually happening.
const MIN_SENTENCE = 12;

// The first piece goes at the first clause end, so speech starts before the first full sentence
// exists. Only ever cut after whitespace: a secret has none, so it reaches scrubSecrets whole.
export function sentenceSplitter(emit) {
  let buffer = "";
  let first = true;
  const clauseEnd = /(?:[.!?…]+|[,;:—–])["')\]]*\s+/g;
  const sentenceEnd = /[.!?…]+["')\]]*\s+/g;
  return {
    push(text) {
      buffer += text;
      let from = 0;
      let scan = 0;
      for (;;) {
        const end = first ? clauseEnd : sentenceEnd;
        end.lastIndex = scan;
        const m = end.exec(buffer);
        if (!m) break;
        scan = m.index + m[0].length;
        if (scan - from < MIN_SENTENCE) continue;
        emit(buffer.slice(from, scan).trim());
        from = scan;
        first = false;
      }
      buffer = buffer.slice(from);
    },
    flush() {
      if (buffer.trim()) {
        emit(buffer.trim());
        first = false;
      }
      buffer = "";
    },
  };
}

export const FILLERS = {
  en: {
    wait: ["One moment, sir.", "Just a moment, sir."],
    still: ["Still working on it, sir.", "Bear with me, sir."],
    github: "Checking GitHub.",
    files: "Reading the files.",
    update: "Updating GitHub.",
    relay: "Passing that to the Orchestrator.",
  },
  sv: {
    wait: ["Ett ögonblick.", "Bara en liten stund."],
    still: ["Jag jobbar fortfarande på det.", "Ha tålamod med mig."],
    github: "Jag kollar GitHub.",
    files: "Jag läser filerna.",
    update: "Jag uppdaterar GitHub.",
    relay: "Jag skickar det till orkestratorn.",
  },
};

export const allFillers = () => Object.values(FILLERS).flatMap((set) => Object.values(set).flat());

export function fillerLanguage(message) {
  const sv = (message.match(/[åäö]|\b(och|jag|det|inte|hur|vad|kan|du|hej|läget)\b/gi) ?? []).length;
  const en = (message.match(/\b(the|is|and|to|of|what|how|can|you|hey)\b/gi) ?? []).length;
  return sv > en ? "sv" : "en";
}

const WRITE = /(^|[;&\s])(gh (pr|issue) (create|edit|comment|close|reopen|ready|merge)|gh run (rerun|cancel)|git (-C \S+ )?push)\b/;

// Which line fits the tool Claude is running, or null if none should be said.
export function toolFiller(name, input, set) {
  if (name === "Read" || name === "Grep" || name === "Glob") return set.files;
  if (name !== "Bash") return null;
  const command = String(input?.command ?? "");
  if (command.includes("ORCHESTRATOR_FIRE_URL")) return set.relay;
  if (WRITE.test(command)) return set.update;
  return /(^|[;&\s])gh /.test(command) ? set.github : null;
}
