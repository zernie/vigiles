/**
 * Who a container runs as and the env its exec gets. The PATH contract between
 * the eval tier (which sends only the stub bin dir, since the host PATH names
 * host directories) and the image is decided here and nowhere else.
 */
type Tc = typeof import("testcontainers");
type Started = import("testcontainers").StartedTestContainer;

/** The host's `uid:gid`, so files the agent writes stay the user's own. */
export const hostUser = (): string => {
  if (process.getuid === undefined || process.getgid === undefined)
    throw new Error("the container runner needs a POSIX host (uid:gid)");
  return `${String(process.getuid())}:${String(process.getgid())}`;
};

/** The image's own `PATH`, read from a started container's env. */
export async function imagePathOf(
  tc: Readonly<Tc>,
  c: Readonly<Started>,
): Promise<string | undefined> {
  const client = await tc.getContainerRuntimeClient();
  const info = await client.container.inspect(
    client.container.getById(c.getId()),
  );
  return pathOf(info.Config.Env);
}

/** `PATH` from a container's `KEY=value` env list. */
export const pathOf = (
  env: readonly string[] | null | undefined,
): string | undefined =>
  env?.find((e) => e.startsWith("PATH="))?.slice("PATH=".length);

/**
 * A `PATH` the run gives (the stub bin dir) goes IN FRONT of the image's own,
 * so a stub shadows a real tool while the harness binary, git and a shell stay
 * reachable; with no `PATH` given, the image's applies unchanged.
 */
export function execEnv(
  run: Readonly<Record<string, string>>,
  imagePath: string | undefined,
): Readonly<Record<string, string>> {
  if (!("PATH" in run) || imagePath === undefined) return run;
  return { ...run, PATH: `${run.PATH}:${imagePath}` };
}
