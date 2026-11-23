/**
 * Harmless LOOK-ALIKES of a dangerous command — the generator behind the
 * battery's "must allow" half (#418).
 *
 * WHY THIS EXISTS. A guard that matches the raw command TEXT blocks every
 * disaster and also blocks a commit message, a heredoc or an `echo` that only
 * MENTIONS one. Each false block costs the agent a turn, and it retries in
 * another form. Measured on a real harness (#418): hooks denied 7.5% of 20,790
 * Bash calls, and the leading cause was banned text carried as data.
 *
 * WHY THE OUTPUT IS TRUSTWORTHY — the mirror image of `bash-equivalents.ts`.
 * There: other text, the same operation, and `sameOperation` must hold. Here:
 * the same text, another operation, and `sharesOperation` must NOT hold
 * for any leaf. "Dangerous" is inherited from the seed a human labelled;
 * "harmless" is decided by the normalizer the gate itself uses. A template whose
 * output runs (part of) its seed makes the generator THROW, so the harmless set
 * can never quietly turn dangerous.
 *
 * WHAT IT DOES NOT PROVE. A look-alike shows the guard does not block a
 * MENTION, not that it lets every harmless command through. A guard whose
 * policy legitimately bans the carrier itself (every `git commit`, say) fails
 * that form; the caller replaces the set.
 */
import { leafCommandsNormalized } from "./bash-effects.js";
import { sharesOperation } from "./bash-equivalents.js";

/** How a look-alike carries its seed's text as data. */
export type LookalikeForm =
  | "commit-message"
  | "heredoc"
  | "echo"
  | "grep-pattern";

/** One way to carry a command's text as data. */
export interface LookalikeTemplate {
  readonly form: LookalikeForm;
  readonly wrap: (command: string) => string;
}

/** POSIX single quoting: the text arrives byte for byte and nothing expands. */
function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** The shipped forms, one per way real hooks were seen to over-block (#418). */
export const LOOKALIKE_TEMPLATES: readonly LookalikeTemplate[] = [
  {
    form: "commit-message",
    wrap: (c) => `git commit -m ${quote(`docs: never run ${c}`)}`,
  },
  // A quoted delimiter: the body is not expanded, so it needs no escaping.
  { form: "heredoc", wrap: (c) => `cat > NOTES.md <<'EOF'\n${c}\nEOF` },
  { form: "echo", wrap: (c) => `echo ${quote(c)}` },
  { form: "grep-pattern", wrap: (c) => `grep -rn ${quote(c)} docs/` },
];

/**
 * One look-alike of `seed` per template, in template order. Throws when the
 * seed does not parse (nothing to prove against), or when a look-alike does not
 * parse or runs an operation of its seed.
 */
export function lookalikeCommands(
  seed: string,
  templates: readonly LookalikeTemplate[] = LOOKALIKE_TEMPLATES,
): readonly { readonly form: LookalikeForm; readonly command: string }[] {
  if (leafCommandsNormalized(seed).length === 0)
    throw new Error(
      `cannot prove a look-alike harmless: the parser reads no command in ${JSON.stringify(seed)}. Pass the harmless cases yourself.`,
    );
  return templates.map(({ form, wrap }) => {
    const command = wrap(seed);
    if (leafCommandsNormalized(command).length === 0)
      throw new Error(
        `look-alike (${form}) does not parse: ${JSON.stringify(command)}`,
      );
    if (sharesOperation(seed, command))
      throw new Error(
        `look-alike (${form}) runs its seed, so it is not harmless: ${JSON.stringify(command)}`,
      );
    return { form, command };
  });
}
