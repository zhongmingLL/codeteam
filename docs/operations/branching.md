# Branch and push workflow

- Default branch: `codeteam`.
- Work branch: `codeteam-work`, tracking `origin/codeteam`.
- Push: `git push origin HEAD:codeteam`. The push is a fast-forward; do not force push.
- If the remote moved: fetch, rebase your own commits, and push again. Never replace remote history.
- CI: `.github/workflows/codeteam-ci.yml` runs on push and pull request to `codeteam`.
- Live Phase 3 demo: `node packages/codeteam/src/cli.ts phase3-demo` or `npm run phase3-demo --workspace=@codeteam/core`.
