// Drive new.ts's cmdSessionLaunch with a scripted collision chooser, as if on
// a terminal, and a transaction stub that prints the record instead of
// launching. argv: <answers,comma-separated> <launch args...>. The chooser and
// the name prompt take answers in order: a chooser answer is a key; a name
// answer is the typed name, "=" for Enter on the default, or "ESC". Each
// chooser call prints `CHOOSE <json>` and each name prompt `ASK <json>` to
// stderr (a refused name prints `REJECT <reason>` and takes the next answer);
// the stub prints `RUN <record json>`, and the [f] arm `FORK <argv json>`.
// SCRIPTED_ON_ASK_PATH/SCRIPTED_ON_ASK_BYTES, when set, are written at the first
// name prompt: the world changing while a human types.
import { writeFileSync } from "node:fs";
import { cmdSessionLaunch } from "../../src/launcher/new";

const [scripted = "", ...args] = process.argv.slice(2);
const answers = scripted ? scripted.split(",") : [];
const code = await cmdSessionLaunch(args, undefined, {
  hasTty: () => true,
  choose: (verb, question, options, fallback) => {
    process.stderr.write(`CHOOSE ${JSON.stringify({ verb, question, options, fallback })}\n`);
    return answers.shift() ?? "q";
  },
  askName: (question, prefix, suffix, check) => {
    process.stderr.write(`ASK ${JSON.stringify({ question, prefix, suffix })}\n`);
    const onAsk = process.env.SCRIPTED_ON_ASK_PATH;
    if (onAsk) { writeFileSync(onAsk, process.env.SCRIPTED_ON_ASK_BYTES ?? ""); delete process.env.SCRIPTED_ON_ASK_PATH; }
    for (;;) {
      const answer = answers.shift() ?? "ESC";
      if (answer === "ESC") return null;
      const name = answer === "=" ? prefix + suffix : answer;
      const reason = check(name);
      if (reason === null) return name;
      process.stderr.write(`REJECT ${reason}\n`);
    }
  },
  fork: async (argv, expectedSource) => {
    process.stdout.write(`FORK ${JSON.stringify(argv)}\n`);
    process.stdout.write(`FORK_SOURCE ${expectedSource}\n`);
    return 0;
  },
  run: async record => {
    process.stdout.write(`RUN ${JSON.stringify(record)}\n`);
    return 0;
  },
});
process.exitCode = code;
