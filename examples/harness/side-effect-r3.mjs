/**
 * ⚠️ EXPERIMENTAL — real side-effect testing against a disposable service (R3).
 *
 * The question promptfoo can't answer cheaply: does my skill ACTUALLY change the
 * world correctly — not "did the model SAY it would," but did the row land in a
 * real Postgres? This spins a throwaway container, lets you drive the skill
 * against it, verifies the REAL resulting state, and tears it down — on your
 * machine, no metered API.
 *
 *   node examples/harness/side-effect-r3.mjs      # needs a running Docker daemon
 *
 * ⚠️ SAFETY — the disposable container is the ONLY isolation. Run this in a
 * disposable environment with NO production access, and keep real credentials
 * (prod DATABASE_URL, cloud keys, ~/.ssh) out of the run. vigiles disposes the
 * container; it does NOT confine the skill. See docs/measuring-skills.md § Safety.
 *
 * The surface is unstable (every name carries `experimental_`); the
 * `measureArms` composition is shown in measure-with-service.mjs.
 * See docs/measuring-skills.md § Experimental and research/r3-disposable-services.md.
 */
import {
  experimental_startServices,
  experimental_dockerRuntime,
} from "../../dist/entries/fixtures.js";

if (!experimental_dockerRuntime.available()) {
  console.log("⊘ SKIPPED — no Docker daemon reachable (this tier needs one)");
  process.exit(77); // vigiles SKIP_EXIT_CODE — a loud skip, never a false pass
}

// 1. Declare a disposable Postgres, seeded with a schema.
const session = await experimental_startServices(
  {
    db: {
      image: "postgres:16-alpine",
      env: { POSTGRES_PASSWORD: "test", POSTGRES_DB: "app" },
      port: 5432,
      // pg_isready over TCP inside the container — passes only once the real
      // post-init Postgres server is up (the temp init server is socket-only).
      ready: { exec: "pg_isready -U postgres -h 127.0.0.1" },

      seed: "psql -U postgres -d app -c 'create table users (id int)'",
    },
  },
  experimental_dockerRuntime,
);

try {
  const db = session.handles.db;
  console.log(
    `db up at ${session.endpoints[0]} — pin egress here, run your skill`,
  );

  // 2. …your skill runs here, applying a migration against the DB…
  //    (stand-in: the effect a migration skill would perform)
  db.exec("psql -U postgres -d app -c 'alter table users add column age int'");

  // 3. Verify the REAL resulting state — the whole point of R3.
  const cols = db
    .exec(
      "psql -U postgres -d app -tAc " +
        "\"select column_name from information_schema.columns where table_name='users'\"",
    )
    .stdout.trim()
    .split("\n")
    .map((s) => s.trim());

  const migrated = cols.includes("age");
  console.log(`columns: ${cols.join(", ")}`);
  console.log(
    migrated ? "✓ migration landed in a REAL Postgres" : "✗ migration missing",
  );
  process.exitCode = migrated ? 0 : 1;
} finally {
  // 4. Dispose — always, even on failure.
  await session.teardown();
}
