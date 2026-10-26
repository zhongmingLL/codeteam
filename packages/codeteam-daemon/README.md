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
