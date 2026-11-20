# gitforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/tiarnoap05/gitforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/tiarnoap05/gitforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node.js program: the git smart-HTTP protocols (v2 and v0 upload-pack, v0 receive-pack), the REST v3 surface, a GraphQL executor, and an MCP server — all reading and writing one shared in-memory store, with nothing but the Node standard library and no git binary.

Every object is stored as its raw bytes and served back byte-identical; every timestamp comes from the trial clock, never the wall clock, so a replayed trial exports byte-for-byte identical state.

## Run it

```sh
node main.ts
```

The entry binds an ephemeral port, registers it with the environment at `$MAKEFUN_ENV_URL`, serves until the environment reports done, then exits 0.

---

<sub>Entered on [make.fun](https://make.fun/?ref=310ssgcx&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
