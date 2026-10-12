# orphan-docs

Flag a markdown doc that **no other markdown file references** — a doc that
quietly rots in a cross-linked corpus because nothing routes a reader (human or
agent) to it. The inverse of stale-reference detection: stale-ref catches a spec
pointing at a missing file; orphan-docs catches an existing file that no `.md`
points at. Implemented in `src/core/orphans.ts`, surfaced by `vigiles lint`.

## Opt-in — and why

This rule is **off unless you opt in** by declaring an `orphans` block in
`.vigilesrc.json`. That's deliberate. "Unreferenced" only means "rot" for a
**hand-cross-linked corpus** — docs that link each other with markdown links. It
does **not** mean rot for a **nav-managed doc site** (Docusaurus, MkDocs,
VitePress), where the page graph lives in `sidebars.js` / `mkdocs.yml` / config,
not in inline links. Pointed at a doc site, the rule flags nearly every page — a
sweep across popular OSS repos found ~100% false positives on doc sites.

So **declaring `orphans.include` is your assertion** that those dirs are a
cross-linked corpus. If they are, the rule is useful; if they're a generated
site, don't opt in (or narrow the scope).

It stays a **warning**, never a hard error, even when opted in: a backtick prose
mention counts as a reference and a page reached only from code does not, so the
signal is a proxy, not a decidable fact.

## Configuration

```json
{
  "orphans": { "include": ["docs/**/*.md", "research/**/*.md"] },
  "overrides": [
    { "files": ["docs/CHANGELOG.md"], "rules": { "orphan-docs": "off" } }
  ]
}
```

| Key       | Default            | Meaning                                                                                                                                     |
| --------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| (block)   | absent → **off**   | The block's **presence** opts the repo in — no block, no scan.                                                                              |
| `include` | `["docs/**/*.md"]` | Dirs to hold to the rule. `docs/` is the convention; add others (e.g. a `research/` notes tree) explicitly. `[]` = opted in, scans nothing. |

`docs/` is the near-universal convention, so it's the default when you opt in
without naming dirs. A vigiles-specific dir like `research/` is **not** in the
default — declare it. This is how "provide dirs" and "default dir" reconcile: the
block's presence is the switch, `include` is the optional override.

To stop the rule reporting some docs, turn it off for their paths with an
[`overrides`](../configuration.md#overrides) entry (as `docs/CHANGELOG.md` above):
those docs still count as links that keep other docs alive. The top-level
`exclude` goes further — an excluded corpus is neither a candidate nor a
referencer. (A per-rule `orphans.exclude` used to exist; it is refused now, with
the equivalent `overrides` entry printed.)

## What it checks

A doc under `include` counts as **referenced** when some _other_ `.md` in the
repo links to it (`[text](path.md)`) or names it in a backtick span
(`` `docs/foo.md` ``). A self-reference doesn't count. Anything else is an orphan.

## What it never flags — harness-loaded instruction files

Files the **harness loads directly** are load-bearing by their name/location, not
because another `.md` links to them, so they're **categorically not docs** and
are never reported as orphans — even if you broaden `include` to the whole repo:

- `CLAUDE.md` / `AGENTS.md` — the instruction file
- `SKILL.md` — a skill
- `agents/*.md` — a subagent
- `commands/*.md` — a slash command

(They're still scanned as _referencers_, so a real doc that only your `CLAUDE.md`
links to is still credited — the exemption only removes them from the orphan
_candidate_ set.)

## Opt out a single doc

For an intentionally-unreferenced doc (a top-level index, a changelog) that isn't
rot, add the inline marker:

```markdown
<!-- vigiles-disable orphan-docs -->
```

…or turn `orphan-docs` off for its path with an
[`overrides`](../configuration.md#overrides) entry (or narrow `orphans.include`).

## Why

A hand-maintained `docs/` tree accumulates files nothing links to; they go stale
because no reader is routed to them. On a corpus that really is cross-linked,
flagging orphans keeps the doc set honest — every doc is reachable from the
README / a spec / another doc, or explicitly marked standalone.
