# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read `AGENTS.md` first — it is the canonical, host-neutral contract for this
repository (product/vault boundaries, bootstrap sequence, mutation protocol,
vault conventions). This file adds Claude Code / development-workflow detail
on top of it and does not restate it.

## What this repository is

claude-obsidian is a **local-first Agent Skills package** (plus a Claude Code
plugin adapter) that turns source material into a linked, source-cited
Obsidian knowledge vault. It ships:

- `skills/` — 15 portable Agent Skills (`skills/<name>/SKILL.md`), invoked in
  Claude Code as `/claude-obsidian:<name>`.
- `claude_obsidian/` — the standard-library-only Python core all skills and
  scripts call into (no third-party dependencies).
- `scripts/claude-obsidian.py` — the CLI wrapper around the core; skills
  never implement knowledge behavior themselves, they shell out to this.
- `hooks/` — Claude Code `SessionStart`/`Stop` hooks that call the core's
  `hook` subcommand. Hooks never define knowledge behavior, only bounded
  status/context emission.
- `templates/vault/` — the deterministic seed for a newly initialized user
  vault.

**Critical distinction: this checkout is the product, never the vault.**
A user's actual knowledge base (`.claude-obsidian.json`, `wiki/`, `.raw/`)
always lives in a *separate* directory, resolved at runtime (explicit
`--vault`, then `CLAUDE_OBSIDIAN_VAULT`, then nearest `.claude-obsidian.json`,
then an unambiguous initialized ancestor vault — fails closed otherwise).
Code must never treat `${CLAUDE_PLUGIN_ROOT}` or the plugin/product tree as a
default vault; `claude_obsidian/paths.py` (`assert_not_plugin_tree`,
`resolve_vault_root`) enforces this at runtime and is defended by
`tests/test_vault_root_separation.py` and `tests/test_installed_tree_boundary.py`.

A checkout with contributor-vault state (root `wiki/`, `.raw/`,
`.vault-meta/`) intentionally has **no marketplace catalog** —
`config/public-marketplace.json` is injected as `.claude-plugin/marketplace.json`
only inside the audited `release build` artifact. Never add vault state to a
contribution, and never hand-edit `.claude-plugin/marketplace.json`.

## Commands

```bash
make test              # everything: python + shell tests, contracts, package validation
make test-python        # each tests/test_*.py run standalone, in isolation
make test-shell          # each tests/test_*.sh run standalone, in isolation
make test-contracts      # scripts/claude-obsidian.py contracts --check-only / --verify
make test-package        # scripts/claude-obsidian.py package validate
make validate            # test-contracts + test-package, without the full test suite
make clean-test-state    # removes .vault-meta/ runtime locks, journals, caches
```

Run a single test file directly (this is how they're designed to run —
`Makefile` just loops over `tests/test_*.py` / `tests/test_*.sh`):

```bash
python3 tests/test_paths.py
bash tests/test_wiki_lock.sh
```

There is no pytest — each `test_*.py` file is a standalone script with a
`main()` that calls its own `test_*` functions in sequence and exits nonzero
on `AssertionError`. Follow that pattern for new tests: hermetic, no network,
no personal paths, no global config, no persistent product state, using
`tempfile` vaults.

Build/audit a release artifact locally (never publishes):

```bash
python3 scripts/claude-obsidian.py release build --output dist/claude-obsidian.zip
python3 scripts/claude-obsidian.py release audit dist/claude-obsidian.zip
```

Portable CLI entry point (also invoked internally by skills, hooks, and
`bin/*.sh`):

```bash
python3 scripts/claude-obsidian.py <command> --vault PATH [...]
```

Key subcommands: `doctor`, `init`, `adopt`, `migrate`, `transaction
inspect|apply|recover`, `lint`, `contracts`, `capture plan|apply`,
`checkpoint`, `package validate`, `release build|audit`. Run `--help` for the
full list — do not duplicate command wrappers.

Requires Python 3.11+. Bash tooling and shell tests are POSIX-only. Vault
writes are unsupported on native Windows (fail closed with
`UNSUPPORTED_PLATFORM`); use WSL — see `docs/windows-wsl.md`.

## Architecture

### The mutation protocol (the load-bearing design)

Every logical knowledge-mutating operation is **one recoverable transaction**,
never a direct write:

1. Read every target file, record its expected SHA-256.
2. Parallel workers (agents, skills) return **drafts and evidence only** —
   they never write vault files themselves.
3. Drafts are merged into one `claude-obsidian.transaction.v1` JSON bundle.
4. `transaction inspect` validates the bundle without mutating anything and
   emits an `approval_sha256`.
5. A human/agent reviews the plan, then `transaction apply` (or a high-level
   planner's `--apply`) executes it — atomically, under one process-lifetime
   `MutationLock` (`claude_obsidian/transaction.py`), journaling backups and
   restoring prior state if the apply can't finish. A changed target between
   inspect and apply is a conflict, never a silent overwrite.
6. Report the `operation_id` and exact changed paths.

High-level mutating commands (`init`, `adopt`, `migrate`, capture, etc.) are
dry-run by default; they print a JSON plan containing `approved_plan_sha256`.
Re-running with `--approved-plan-sha256 <hash> --apply` executes only if the
regenerated plan hashes identically (`claude_obsidian/cli.py`:
`_require_approved_plan` uses `hmac.compare_digest`). Any filesystem drift
between plan and apply fails closed before writing.

Consequences for how to write code and skills here:

- Query/lint operations (`wiki-query`, `wiki-lint`) are **strictly
  read-only**.
- Never add a direct/shared-write code path, resurrect the deprecated
  `scripts/wiki-lock.sh` per-file locking, or add generic auto-commit
  behavior. `claude_obsidian/legacy_lock.py` exists only for legacy
  compatibility, not as a pattern to extend.
- Git checkpointing (`checkpoint` command) is a separate, explicit operation
  — never implicit.
- Raw source payloads under a vault's `.raw/` are create-only;
  `.raw/.manifest.json` is the only mutable legacy raw metadata file
  (`claude_obsidian/capture.py`).
- Network egress, destructive repair, and canonical research merges
  (`autoresearch`) all require explicit user consent — there is no default
  path that reaches the network.

### Core module map (`claude_obsidian/`)

- `paths.py` — vault-root resolution/selection, path containment
  (`assert_within`), plugin-tree exclusion, cross-platform symlink/junction
  and file-identity safety. This is the security boundary; read it before
  touching any path-handling code.
- `transaction.py` — `MutationLock`, bundle inspect/apply/recover, atomic
  write primitives, SHA-256 verification.
- `capture.py` — inbox/local-file capture planning and apply (content-addressed,
  immutable payloads), external-action planning for URL/YouTube/OCR adapters.
- `vault_ops.py` — building/scanning vault-wide operation bundles (used by
  `init`/`adopt`/`migrate`).
- `ledgers.py` — source/claim provenance ledger schema and validation.
- `lint_engine.py` — deterministic health checks (dead links, orphans,
  metadata gaps, stale indexes, empty sections); `--as-of` makes findings
  reproducible for a given UTC date.
- `mode_config.py` — Generic/LYT/PARA/Zettelkasten filing-mode configuration.
- `contracts.py` / `gates.py` — capability-readiness and release-gate
  verification (what `make test-contracts` runs).
- `package_validation.py` — validates skill frontmatter, hook manifests,
  and package metadata coherence (what `make test-package` runs).
- `hook_adapter.py` — implements the Claude Code `SessionStart`/`Stop` hook
  payloads (bounded `wiki/hot.md` context injection, gated by
  `CLAUDE_OBSIDIAN_SESSION_CONTEXT=1`, which must never be set implicitly).
- `release.py` — builds and self-audits the deterministic, distribution-clean
  public artifact (injects the reviewed marketplace catalog, strips
  contributor/runtime state).
- `extensions.py` — optional legacy extension bundles (e.g. "dragonscale")
  wired through `bin/setup-*.sh`.
- `json_utils.py` — strict JSON parsing helpers shared across the core
  (reject duplicate keys, non-finite numbers — see `paths.py` usage).

`scripts/` beyond the main CLI are standalone helpers used by skills/tests:
`bm25-index.py`, `retrieve.py`, `rerank.py`, `contextual-prefix.py` (retrieval
pipeline used by `wiki-retrieve`), `boundary-score.py`/`tiling-check.py`
(chunking), `wiki-mode.py`, `detect-transport.sh`/`allocate-address.sh`
(Obsidian CLI transport detection for `wiki-cli`).

### Skills (`skills/<name>/SKILL.md`)

Frontmatter is intentionally minimal: exactly `name` and a single-line
`description` (the portable Agent Skills subset — no extra fields). Do not
mirror skills under a `commands/` directory; Claude Code invokes them by
namespaced slash command directly from `skills/`.

- Core loop: `wiki` (setup/routing) → `wiki-ingest` (source → linked pages +
  provenance) → `wiki-query` (read-only answers) → `save` (persist one
  reviewed answer/insight, never an automatic transcript) → `wiki-lint`
  (health check).
- Extensions: `autoresearch` (bounded web research, separate consent for
  egress and for merging into canon), `canvas` (Obsidian JSON Canvas),
  `defuddle` (optional external cleaner for web sources), `wiki-fold`
  (extractive log rollups), `wiki-mode` (methodology routing), `wiki-retrieve`
  (BM25 + optional reranked retrieval), `wiki-cli` (optional Obsidian CLI
  transport for reads/search only — mutations still go through the
  transaction core).
- Reference-only skills (no vault mutation): `obsidian-markdown`,
  `obsidian-bases`, `think`.

Each skill resolves the product core by absolute path from its own
installation and calls `scripts/claude-obsidian.py`, rather than assuming a
working directory.

### Vault layout (in a *user's* vault, not this repo)

```
.claude-obsidian.json   # workspace config: schema + vault path
inbox/                  # visible capture intake, never auto-deleted
.raw/                   # immutable, content-addressed source payloads
wiki/                   # generated knowledge pages
wiki/meta/ledgers/      # source and claim provenance
wiki/hot.md             # bounded recent context (not a transcript)
wiki/log.md             # operation history, newest first
.vault-meta/            # ignored runtime: locks, journals, indexes, queues, config
.obsidian/               # Obsidian app config
```

### Tests (`tests/`)

One `test_*.py` or `test_*.sh` file per subject module/script, each runnable
standalone and hermetic (temp-dir vaults, no network, no personal paths, no
global/persistent state). Behavior changes should add: a regression test that
fails on old behavior, proportional success/conflict/invalid-input/recovery
coverage, updated docs, and a `## [Unreleased]` entry in `CHANGELOG.md`.

For non-trivial changes, run the read-only fresh-context verifier described
in `agents/verifier.md` (inspects the worktree or a declared scope; never
stages, commits, pushes, or modifies files) and resolve BLOCKER/HIGH findings
before requesting review.

## Conventions

- Obsidian Flavored Markdown in generated content: flat YAML frontmatter
  properties, `YYYY-MM-DD` dates, wikilinks, embeds, valid callouts. Never
  fabricate evidence locators, quotations, page numbers, or confidence
  scores — see `wiki/meta/ledgers/` provenance model.
- High-risk accepted claims require two independent sources; unsupported or
  contradictory evidence stays visible rather than being suppressed. Prefer a
  grounded refusal over an invented citation. Model-based retrieval falls
  back to deterministic BM25 when embedding/reranking can't be trusted.
- Conventional Commits where practical; no automated pushes, tags, issue
  mutation, or releases without explicit owner approval.
- Capability claims (performance, competitor comparisons, tool support) must
  be traceable to current evidence — the `config/capabilities.json` /
  `contracts.py` model exists specifically to state capability maturity
  honestly rather than simulate unimplemented adapters.
