/**
 * Matches Python `launcher.LauncherError` so refusal text is comparable.
 *
 * `errorClass` carries the refusal's CLASS as data rather than only as a prefix
 * inside `message`. The incumbent raises `PresetError(error_class, remedy,
 * detail)`, and a differential against it showed every TypeScript refusal
 * arriving with no class at all -- the text agreed, the typed boundary did not.
 * That is the shape rule 19 exists to stop: a caller that can only substring-match
 * a message cannot distinguish an infrastructure failure from a predicate answer.
 * `message` is unchanged, so existing text matching keeps working.
 */
export class LauncherError extends Error {
  readonly errorClass: string | null;
  /**
   * What the OPERATOR should do about it -- `chmod 600 <path>`, `create <path>`,
   * `choose an available preset (a, b)`. The incumbent's
   * `PresetError(error_class, action, detail)` carries three things and a
   * differential showed this one being dropped: the class survived, the detail
   * survived, and the repair instruction did not. A refusal that says what is
   * wrong but not what to do is a worse product, and it is invisible in any test
   * that only asserts the class.
   */
  readonly action: string | null;
  /**
   * The incumbent's third field: what is wrong, WITHOUT the class prefix that
   * `message` carries. Consumers that render a refusal to an operator want this,
   * not a string they have to strip a machine token off the front of.
   */
  readonly detail: string | null;
  /** Preserved for callers that branch on `error.code` (an absent file stays ENOENT). */
  readonly code: string | undefined;
  constructor(message: string, errorClass: string | null = null, action: string | null = null,
              detail: string | null = null, code?: string) {
    super(message);
    this.name = "LauncherError";
    this.errorClass = errorClass;
    this.action = action;
    this.detail = detail ?? null;
    this.code = code;
  }
}
