---
name: x-research
description: >
  Searches X/Twitter for real-time perspectives, dev discussions, product feedback,
  breaking news, and expert opinions using the X API v2. Provides search with
  engagement sorting, user profiles, thread fetching, watchlists, and result caching.
  Use when: (1) user says "x research", "search x for", "search twitter for",
  "what are people saying about", "what's twitter saying", "check x for", "x search",
  (2) user needs recent X discourse on a topic (library releases, API changes, product
  launches, industry events), (3) user wants to find what devs/experts/community thinks
  about a topic. NOT for: posting tweets or account management.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Write
  - WebFetch
---

# X Research

Agentic research over X/Twitter. Decompose research questions into targeted searches,
iteratively refine, follow threads, deep-dive linked content, and synthesize sourced
briefings.

For X API details (endpoints, operators, response format): read
`{baseDir}/skills/x-research/references/x-api.md`.

## Prerequisites

- **X API Bearer Token** -- set `X_BEARER_TOKEN` (or `XAI_API_KEY`) env var
- **Python 3.11+** and **uv** (`pip install uv` or https://docs.astral.sh/uv/)

## CLI Tool

All commands use `uv run` for automatic dependency management:

### Search

```bash
uv run {baseDir}/skills/x-research/scripts/x_search.py search "<query>" [options]
```

**Options:**
- `--sort likes|impressions|retweets|recent` -- sort order (default: likes)
- `--since 1h|3h|12h|1d|7d` -- time filter (default: last 7 days)
- `--min-likes N` -- filter by minimum likes
- `--min-impressions N` -- filter by minimum impressions
- `--pages N` -- pages to fetch, 1-5 (default: 1, 100 tweets/page)
- `--limit N` -- max results to display (default: 15)
- `--quick` -- quick mode: 1 page, max 10 results, auto noise filter, 1hr cache
- `--from-user <username>` -- shorthand for `from:username` in query
- `--quality` -- filter low-engagement tweets (min 10 likes, post-hoc)
- `--no-replies` -- exclude replies
- `--save` -- save results to `~/x-research-output/`
- `--json` -- raw JSON output
- `--markdown` -- markdown output for research docs

Auto-adds `-is:retweet` unless query already includes it. All searches display estimated API cost.

**Examples:**
```bash
uv run {baseDir}/skills/x-research/scripts/x_search.py search "claude code" --sort likes --limit 10
uv run {baseDir}/skills/x-research/scripts/x_search.py search "from:anthropic" --sort recent
uv run {baseDir}/skills/x-research/scripts/x_search.py search "(cursor OR windsurf) AI editor" --pages 2 --save
uv run {baseDir}/skills/x-research/scripts/x_search.py search "AI agents" --quick
uv run {baseDir}/skills/x-research/scripts/x_search.py search "AI agents" --quality --quick
```

### Profile

```bash
uv run {baseDir}/skills/x-research/scripts/x_search.py profile <username> [--count N] [--replies] [--json]
```

Fetches recent tweets from a specific user (excludes replies by default).

### Thread

```bash
uv run {baseDir}/skills/x-research/scripts/x_search.py thread <tweet_id> [--pages N]
```

Fetches full conversation thread by root tweet ID.

### Single Tweet

```bash
uv run {baseDir}/skills/x-research/scripts/x_search.py tweet <tweet_id> [--json]
```

### Watchlist

```bash
uv run {baseDir}/skills/x-research/scripts/x_search.py watchlist                        # Show all
uv run {baseDir}/skills/x-research/scripts/x_search.py watchlist add <user> [note]      # Add account
uv run {baseDir}/skills/x-research/scripts/x_search.py watchlist remove <user>           # Remove
uv run {baseDir}/skills/x-research/scripts/x_search.py watchlist check                   # Check recent
```

Watchlist stored in `{baseDir}/skills/x-research/data/watchlist.json`.

### Cache

```bash
uv run {baseDir}/skills/x-research/scripts/x_search.py cache clear
```

15-minute TTL. Avoids re-fetching identical queries.

## Research Loop (Agentic)

When doing deep research (not just a quick search), follow this loop:

### 1. Decompose the Question into Queries

Turn the research question into 3-5 keyword queries using X search operators:

- **Core query**: Direct keywords for the topic
- **Expert voices**: `from:` specific known experts
- **Pain points**: Keywords like `(broken OR bug OR issue OR migration)`
- **Positive signal**: Keywords like `(shipped OR love OR fast OR benchmark)`
- **Links**: `url:github.com` or `url:` specific domains
- **Noise reduction**: `-is:retweet` (auto-added), add `-is:reply` if needed
- **Spam filter**: Add `-airdrop -giveaway -whitelist` for crypto-adjacent topics

### 2. Search and Extract

Run each query via CLI. After each, assess:
- Signal or noise? Adjust operators.
- Key voices worth searching `from:` specifically?
- Threads worth following via `thread` command?
- Linked resources worth deep-diving with `WebFetch`?

### 3. Follow Threads

When a tweet has high engagement or is a thread starter:
```bash
uv run {baseDir}/skills/x-research/scripts/x_search.py thread <tweet_id>
```

### 4. Deep-Dive Linked Content

When tweets link to GitHub repos, blog posts, or docs, fetch with `WebFetch`. Prioritize links that:
- Multiple tweets reference
- Come from high-engagement tweets
- Point to technical resources directly relevant to the question

### 5. Synthesize

Group findings by theme, not by query:

```
### [Theme/Finding Title]

[1-2 sentence summary]

- @username: "[key quote]" (NL, NI) [Tweet](url)
- @username2: "[another perspective]" (NL, NI) [Tweet](url)

Resources shared:
- [Resource title](url) -- [what it is]
```

### 6. Save

Use `--save` flag or save manually.

## Refinement Heuristics

- **Too much noise?** Add `-is:reply`, use `--sort likes`, narrow keywords
- **Too few results?** Broaden with `OR`, remove restrictive operators
- **Spam flooding results?** Add `-$ -airdrop -giveaway -whitelist`
- **Expert takes only?** Use `from:` or `--min-likes 50`
- **Substance over hot takes?** Search with `has:links`

## When to Use

- Researching what developers/experts/community thinks about a topic
- Getting real-time perspectives on breaking news or product launches
- Finding technical discussions about libraries, frameworks, or APIs
- Monitoring what key accounts are posting about
- Gathering sourced evidence for competitive analysis or market research
- Quick pulse check on a topic before deeper investigation

## When NOT to Use

- Posting tweets, replying, or managing an X account (read-only tool)
- Historical research beyond 7 days (uses recent search endpoint only)
- Searching non-X platforms (use web search tools instead)
- Tasks where web search provides better results (X is best for real-time
  opinions, discussions, and breaking news -- not reference docs)

## Cost Awareness

X API uses pay-per-use pricing ($0.005/post read, $0.01/user lookup). Quick mode
keeps costs under ~$0.50/search. Always check the cost display after each search.
Cache prevents duplicate charges. See `references/x-api.md` for full pricing.

## File Structure

```
skills/x-research/
  SKILL.md           (this file)
  scripts/
    x_search.py      (CLI entry point, run with uv)
    x_api.py         (X API wrapper)
    x_cache.py       (file-based cache, 15min TTL)
    x_format.py      (terminal + markdown formatters)
  data/
    watchlist.json   (accounts to monitor)
    cache/           (auto-managed)
  references/
    x-api.md         (X API endpoint reference)
```
