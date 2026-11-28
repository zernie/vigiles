# `vigiles/fixtures`

The world a test runs against: fake command-line tools on `PATH` and disposable
services. Nothing here calls a model.

**For:** test authors who need a harness run to talk to something safe: a stubbed
`gh`, or a throwaway Postgres. This is setup, not assertion; the checks live in
[`vigiles`](https://zernie.github.io/vigiles/api/) and the runners in
[`vigiles/eval`](eval.md).

Signatures are in the [generated API reference](https://zernie.github.io/vigiles/api/).
Depth: [stubbing a CLI and disposable services](../measuring-skills.md#stubbing-a-cli-the-agent-calls--experimental_stub).

## Typical tasks

### Stub a CLI the agent calls

A stub answers per invocation, by rules over the argv. A call no rule answers
fails the eval.

```ts
import { defineEval } from "vigiles";
import { experimental_stub } from "vigiles/fixtures";

const { rest } = experimental_stub;
const gh = experimental_stub("gh", [
  {
    argv: ["issue", "create", rest],
    reply: { kind: "always", stdout: "https://github.com/o/r/issues/9001\n" },
  },
]);

export default defineEval({
  runEval: {
    env: { kind: "local", inherit: "none" },
    stubs: [gh],
    arms: { baseline: {}, skill: { pluginDir: "./my-plugin" } },
    task: "File this as an issue: init breaks in a Yarn PnP repo.",
    measure: (ctx) => ({
      filed: experimental_stub
        .called("gh", ["issue", "create", rest], { contains: ["o/r"] })
        .eval(ctx).pass,
    }),
  },
});
```

### Check how often a stub was called

`experimental_stub.called` takes a `StubCalledBounds` (`min`, `max`, `contains`)
as its third argument and counts answered calls only.

### Run a disposable service

Start it, use it, and tear it down in a `finally`. This starts a Docker
container and is the only isolation vigiles provides, so run it somewhere
disposable. Read [the safety note](../measuring-skills.md#-safety--read-this-before-running-r3) first.

```ts
import {
  experimental_startServices,
  experimental_dockerRuntime,
} from "vigiles/fixtures";

const svc = await experimental_startServices(
  {
    db: {
      image: "postgres:16",
      env: { POSTGRES_PASSWORD: "test", POSTGRES_DB: "app" },
      port: 5432,
      ready: { exec: "pg_isready -U postgres -h 127.0.0.1 -d app" },
      seed: "psql -U postgres -d app -c 'create table users (id int)'",
    },
  },
  experimental_dockerRuntime,
);
try {
  console.log(svc.endpoints[0]); // host:port of the db
  console.log(
    svc.handles.db.exec("psql -U postgres -d app -tAc 'select 1'").stdout,
  );
} finally {
  await svc.teardown();
}
```

### Use a runtime other than Docker

Implement `ContainerRuntime` (`name`, `available`, `start`, `stop`) and pass it in
place of `experimental_dockerRuntime`. Each `start` returns a `ServiceHandle`.

## Exports

### Tool stubs

- `experimental_stub`: build a stub for a named command; its `.rest` token matches any further arguments and its `.called` makes a check that counts calls.
- `StubCalledBounds`: the bounds of `experimental_stub.called`: `min`, `max` and `contains`.

### Disposable services

- `experimental_startServices`: start every service in a record on a runtime and return a session; the container lives for the whole run.
- `experimental_dockerRuntime`: the Docker backend of `ContainerRuntime`.
- `ContainerRuntime`: the port a backend implements: `name`, `available`, `start`, `stop`.
- `DockerExec`: the shape of a synchronous `docker` call (arguments in; `stdout`, `stderr` and `code` out), which the Docker backend is built on.
- `ServiceSpec`: one service: `image`, `env`, `port`, `ready`, `seed`, `reset`.
- `ServiceReady`: how to tell the service is up: a `tcp` port, a `log` pattern or an `exec` command.
- `ServiceReset`: when state resets, `"per-trial"` or `"per-arm"`.
- `ServiceHandle`: a running service: `host`, `port`, `url` and `exec` for running a command inside it.
- `ServiceSession`: the result of starting services: `endpoints`, `handles` and `teardown`.
