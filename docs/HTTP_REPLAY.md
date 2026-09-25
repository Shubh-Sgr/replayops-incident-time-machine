# Bounded HTTP replay and CI regression

ReplayOps supports a deliberately narrow replay workload: one captured HTTP request, an identified application version, explicit response assertions, and declared dependency fixtures. It does not claim to replay an entire distributed production system.

## Safety boundary

- Execution targets only `localhost`, `127.0.0.1`, or `::1`.
- Authorization, cookie, token, secret, and API-key headers are removed.
- Each request has a five-second timeout and a 64 KB response limit.
- The same request runs twice. Different outputs fail as nondeterministic.
- No production write credentials are stored or supplied.
- Every application execution is bound to the incident evidence revision captured with the replay spec.

## Create and run from ReplayOps

Open an investigation, choose **Validate & recover**, then save a **Bounded HTTP replay**. Set `REPLAY_TARGET_BASE_URL` on the API only when a candidate service is running in the same isolated local or CI environment. Public hosting should leave it unset; ReplayOps reports the execution as unsupported instead of simulating success.

## Run a generated regression in CI

1. Download the replay manifest from the investigation.
2. Start the old or candidate application on a loopback port with mocked dependencies and no production credentials.
3. Run:

```bash
REPLAY_TARGET_BASE_URL=http://127.0.0.1:4010 npm run replay:http -- replay.json
```

The command exits non-zero when an assertion fails, two identical requests disagree, the target is not loopback, or the input is unsupported. This gives a standard CI gate: the saved production failure should fail against the old build and pass against the candidate fix.

The sample manifest in `examples/http-replay/checkout-regression.json` documents the portable schema. Dependency fixtures are preserved for the test harness; ReplayOps does not silently invent a dependency mock implementation.
