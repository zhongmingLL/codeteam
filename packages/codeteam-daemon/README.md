# @codeteam/daemon

Minimal daemon lifecycle for codeteam: `CODETEAM_DATA_DIR` state, an append-only boot ledger, a
single-writer fence, loopback `/health`, and `requested → ready → stopping → stopped/failed`.

```ts
import { startDaemon } from "@codeteam/daemon";

const daemon = await startDaemon({
  installationRoot: "/path/to/codeteam",
  runningRevision: "abc123",
  services: ["api"],
});
daemon.markReady();
console.log(daemon.healthUrl);
await daemon.stop();
```

The daemon never reports ready before `markReady`, and `markReady` fails closed if a declared service
is missing or an undeclared one is reported. W5's authorization/reverification chain is out of scope.

## Control store (W1)

`openControlDatabase({ dataDir })` creates `<dataDir>/control.db` with `0600` permissions inside a
`0700` data directory, enables WAL, foreign keys, and a 5000 ms busy timeout, then applies
forward-only migrations. The control store owns threads, messages, queue entries, tasks, runs,
handoffs, approvals, reviews, and the rest of the W1 schema; it is not the pi transcript.

```ts
import { openControlDatabase } from "@codeteam/daemon";

const control = openControlDatabase({ dataDir: process.env.CODETEAM_DATA_DIR });
console.log(control.schemaVersion);
control.close();
```

Migration heads are contiguous and checked against `schema_migrations`; a failed migration rolls
back atomically, and a database with an unknown/ahead version fails closed. `CODETEAM_SQLITE_BUSY_TIMEOUT_MS`
overrides the default busy timeout.

WAL and `-shm` files are created by SQLite with the process umask; their confidentiality relies on
the `0700` data directory. Set `umask 077` or pre-create the files if a deployment requires explicit
modes.
