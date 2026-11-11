# CLAUDE.md

Guidance for Claude Code working in this repo. A living document; update it as the project evolves.

## What this is

datapitfalls bench. The product spec is **docs/PRD.md**: read it before starting any work, and keep it in sync with what ships. Requirement IDs in the PRD (e.g. B1) are the shared language for issues, commits and PRs.

## Family and contracts

- Builds on [datapitfalls](https://github.com/bjonesdataliteracy/datapitfalls) (core engine, taxonomy, MCP). Use its public exports only, never internals.
- Shared data shapes (Finding, Transcript, Memory record, Trap) come from `@datapitfalls/schemas` (on npm since 0.1.0). Import them; don't redefine them here.
- Every finding, trap and memory cites at least one taxonomy rule ID.

## Principles

- Local-first; never send user data anywhere without explicit opt-in.
- Read-only access to data; never write to a user's warehouse.
- TypeScript, matching the core repo's tooling (ESLint, Prettier, `node --test`). Node 22.13+, because the harness reads SQLite through the built-in `node:sqlite`. The data builder and trap scanner in `data/` are Python, standard library only.
- Gold answers and trap answers are for scoring. Never show them, or the question file, to an agent under test.

## The gate (run before committing code)

```
npm test && npm run lint
```

`npm test` builds first and never calls an API. Checks that need the real database (`npm run check:evidence`, `datapitfalls-bench check`) are run by hand; say whether you ran them.

## Spending

`datapitfalls-bench run` without `--dry-run` or a scripted `--agent` calls a paid API. Never start a live run without the maintainer's explicit go-ahead for that run and its budget. Use `--dry-run` freely.

## Branches

Work on descriptive `claude/<topic>` branches and open PRs to `main`. This is standing permission to push to a self-named `claude/<topic>` branch.

## Verification honesty

A cloud session usually has no live Anthropic API key. Don't claim a run worked if you couldn't execute it; say what you verified and flag what you couldn't.
