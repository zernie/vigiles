/**
 * The environment of every git process vigiles starts on a workspace: every
 * inherited `GIT_*` variable dropped (a `GIT_DIR`, `GIT_INDEX_FILE` or
 * `GIT_WORK_TREE` set by a git hook or a shell would point the command back
 * at the caller's checkout, and `GIT_CONFIG_COUNT` injects config), the
 * user's global and system git config switched off (so `core.excludesFile`,
 * `diff.external`, `diff.noprefix` or a hook path cannot change what a trial
 * touched), the repository's hooks off (`core.hooksPath` set on the command
 * line outranks the repo's own, and a `post-index-change` hook fires even on
 * a temporary index), no lazy fetch into a partial clone (`GIT_NO_LAZY_FETCH`;
 * a git too old to know it still fetches, so a caller that must not write
 * refuses a partial clone first), a neutral identity, no credential prompt.
 */

/** The identity of the commits vigiles makes in its own copies. */
export const IDENTITY = {
  GIT_AUTHOR_NAME: "vigiles",
  GIT_AUTHOR_EMAIL: "vigiles@localhost",
  GIT_COMMITTER_NAME: "vigiles",
  GIT_COMMITTER_EMAIL: "vigiles@localhost",
} as const;

/** `process.env` without any `GIT_*`, with git's user and system config and the repo's hooks off, and the identity set. */
export function gitEnv(): Readonly<NodeJS.ProcessEnv> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
    ),
    ...IDENTITY,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}
