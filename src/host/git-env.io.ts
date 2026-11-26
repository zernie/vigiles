/**
 * The environment of every git process vigiles starts on a workspace: the
 * user's global and system git config switched off (so `core.excludesFile`,
 * `diff.external`, `diff.noprefix` or a hook path cannot change what a trial
 * touched), a neutral identity, no credential prompt.
 */

/** The identity of the commits vigiles makes in its own copies. */
export const IDENTITY = {
  GIT_AUTHOR_NAME: "vigiles",
  GIT_AUTHOR_EMAIL: "vigiles@localhost",
  GIT_COMMITTER_NAME: "vigiles",
  GIT_COMMITTER_EMAIL: "vigiles@localhost",
} as const;

/** `process.env` with git's user and system config off and the identity set. */
export function gitEnv(): Readonly<NodeJS.ProcessEnv> {
  return {
    ...process.env,
    ...IDENTITY,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}
