// Leak-safe failure diagnostics for the real-Firefox smoke test.
//
// The Firefox smoke test handles the pairing token (it is even carried in
// the fixture page's URL) and reads page text, URLs and
// service responses that came from a real browser. None of that may reach
// stdout/stderr — CI logs outlive the run — so every failure message the
// smoke test prints is built from stable status/code/count values only:
//
//   - DiagnosticError: an Error whose message is, by construction, made only
//     of fixed text, numbers, and `safeLabel`ed identifiers. It is the one
//     kind of error whose message `describeError` will print.
//   - safeLabel: passes a short identifier-shaped string (a status or error
//     code) through, and replaces anything else — including any free-form
//     text a browser or the service could have put there — with a placeholder.
//   - describeError: for any other thrown value (a JSON SyntaxError quoting
//     the offending text, a Node network error, ...) prints only its `name`
//     and `code`, never its `message`.

const SAFE_LABEL_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const UNRECOGNIZED = "(unrecognized)";

export class DiagnosticError extends Error {
  constructor(message) {
    super(message);
    this.name = "DiagnosticError";
  }
}

export function safeLabel(value) {
  return typeof value === "string" && SAFE_LABEL_PATTERN.test(value) ? value : UNRECOGNIZED;
}

export function describeError(error) {
  if (error instanceof DiagnosticError) return error.message;
  const name = safeLabel(error?.name);
  const code = safeLabel(error?.code);
  return code === UNRECOGNIZED ? name : `${name}/${code}`;
}
