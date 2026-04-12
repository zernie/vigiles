# Code Search for AI Coding Agents

Research on how AI coding agents find and read code. Agents spend ~99% of their time reading. This document compares approaches: grep, AST-based search, embeddings, LSP, and graph databases.

---

## The Problem

AI coding agents (Claude Code, Codex, Cursor, Aider) spend most of their time _finding_ code, not _writing_ it. The search strategy determines both cost (tokens burned) and quality (did the agent find the right context?).

The fundamental tension: **exact matching** (fast, deterministic, requires knowing what to search for) vs. **semantic matching** (slower, approximate, works when you don't know the symbol name).

---

## 1. Ripgrep — The Current Baseline

### How it works

Ripgrep (`rg`) is a Rust text search tool. Performance comes from:

- **SIMD-accelerated literal matching**: Uses the `memchr` crate and Intel's Teddy algorithm. When a regex contains literal substrings, ripgrep extracts them and uses SIMD to skip through files without entering the regex engine.
- **Lock-free parallel directory walking**: Built on `crossbeam` and the `ignore` crate. Traverses directories in parallel across all CPU cores.
- **Smart filtering**: Respects `.gitignore` natively, skips binary files.
- **Lazy line isolation**: When a candidate match is found via literal scan, only that line's boundaries are located and the full regex runs on that line alone.

### Performance

| Benchmark                         | Ripgrep | GNU grep | Speedup                   |
| --------------------------------- | ------- | -------- | ------------------------- |
| Linux kernel full search          | ~0.06s  | ~0.67s   | 10x                       |
| Node.js project (with .gitignore) | —       | —        | 302x (skips node_modules) |
| Common identifier search          | —       | —        | 9.2x                      |

Typical AI agent usage: 10-30 searches per task, each completing in 20-50ms.

### How Claude Code uses it

Three-tool hierarchy in cost-ascending order:

1. **Glob** — pattern-matching file discovery, returns only paths (near-zero token cost)
2. **Grep** — ripgrep content search, returns matching lines with context (low cost)
3. **Read** — full file loading (500-5,000 tokens per file)

For heavy exploration, Claude Code spawns an **Explore sub-agent** on Haiku (15x cheaper per token). This sub-agent searches, summarizes, and returns results — preventing exploration costs from consuming the main context.

**Key finding from Anthropic**: Early Claude Code versions used RAG + a local vector DB. They abandoned it because agentic search "outperformed everything by a lot, and this was surprising" (Boris Cherny, Latent Space podcast, May 2025). Reasons: exact symbol matching beats fuzzy similarity for code, no index staleness, no privacy concerns from stored embeddings.

### Strengths

- Deterministic — same query always returns same results
- Zero setup, zero indexing
- Never stale — always searches current filesystem state
- Low token cost per search (returns just matching lines)

### Weaknesses

- **No concept search**: Can't find code by concept when you don't know the symbol name. If `createD1HttpClient` was renamed to `buildGatewayClient`, grep finds nothing.
- **Structurally blind**: `useState` in a comment matches the same as `useState` in code.
- **Noisy on common terms**: Searching `useState` in a React codebase returns hundreds of matches.
- **No cross-reference understanding**: Can't follow type hierarchies, call chains, or data flow.

### Is it actually inefficient?

Amazon Science (Feb 2026): keyword search via agentic tool use achieves **over 90% of RAG-level performance** without a vector database. One developer reduced Claude Code's input tokens by 83% with optimized ripgrep patterns via an MCP server. The Milvus team argued the grep-only approach "burns too many tokens" on large codebases. But Claude Code compensates with prompt caching (92% prefix reuse rate, cache reads at 0.1x price).

**Verdict**: Efficient enough for most repos. Token cost is real but manageable with caching. The simplicity advantage (zero infrastructure) is underrated.

---

## 2. ast-grep — Structural Code Search

### How it works

ast-grep parses source code into an AST using tree-sitter, then matches patterns against tree structure rather than text. Written in Rust.

Pattern syntax uses **metavariables**: `$VAR` captures a single AST node, `$$$` captures zero or more sequential nodes.

```
# Find all console.log calls regardless of arguments
console.log($$$)

# Find async functions without try/catch
async function $FN($$$ARGS) { $$$ }

# Find React components using a specific hook
function $COMPONENT($$$) { const $VAR = useState($$$); $$$ }
```

Queries impossible with text grep become natural: "find all async functions without error handling", "find functions with more than 3 parameters."

### Performance

| Benchmark                    | ast-grep                    | Ripgrep |
| ---------------------------- | --------------------------- | ------- |
| Single pattern on TypeScript | ~0.5s                       | ~0.02s  |
| Six rules on same codebase   | 0.975s (after optimization) | —       |

Optimization history on six-rule benchmark:

- Original: 10.8s
- Avoid expensive regex cloning: 5.3s
- BitSet-based `potential_kinds` (skip non-matching AST node types): 3.6s
- Eliminate duplicate tree traversal (combine rules): 0.975s (11x total improvement)

### Advantages

- **Structural precision**: Distinguishes function definitions from calls from comments
- **Refactoring-safe**: Pattern captures actual function invocations, not string mentions
- **Language-aware**: 26+ languages via tree-sitter grammars
- **Composable rules**: Can combine with relational rules ("find X inside Y")
- **Deterministic**: Yes

### Limitations

- **5-25x slower than ripgrep** for simple text searches (must parse full AST)
- **Pattern authoring complexity**: Agents struggle to write correct ast-grep patterns without explicit training
- **Not a grep replacement**: Best as a complement — grep to narrow, ast-grep to verify structurally

### AI agent integration

ast-grep provides an MCP server (`ast-grep-mcp`) and a Claude Code skill. As of late 2025, Claude Code "cannot automatically detect when to use ast-grep for all appropriate use cases" — requires explicit system instructions.

**Vigiles relevance**: ast-grep is the natural backend for `check()` assertions that go beyond file pairing. `no("src/**/*.ts").matches("console.log($$$)")` could be powered by ast-grep.

---

## 3. Embeddings-Based Search

### Cursor's approach

1. **AST-based chunking**: Tree-sitter parses code into AST, depth-first traversal splits into sub-trees within token limits, merging sibling nodes to avoid over-fragmentation.
2. **Custom embedding model**: Trained using a novel feedback loop — during agent sessions, analyze which files the agent eventually needed, have an LLM rank optimal retrieval at each step, train the embedding model to align.
3. **Turbopuffer vector database**: Remote vector store for nearest-neighbor search.
4. **Merkle tree synchronization**: Hierarchical hash for efficient change detection. Root hash compared every 10 minutes; only changed files re-embedded.
5. **Privacy**: File paths obfuscated with client-side encryption. Only embeddings stored remotely.

**Cursor's own benchmark results**:

- 12.5% higher accuracy vs. grep alone
- 2.6% code retention improvement on large codebases (1,000+ files)
- 2.2% fewer dissatisfied follow-up requests

The gains are real but modest. Cursor concludes: "the combination of grep and semantic search leads to the best outcomes."

### Aider's repo-map (NOT embeddings)

Aider's approach is graph-based, not embedding-based:

1. **Tree-sitter parsing**: Extracts definitions and references across 40+ languages.
2. **Dependency graph**: Each source file is a node; edges connect files with cross-references.
3. **Personalized PageRank**: Files in active chat get high weight; ranks files by structural importance relative to current context.
4. **Token budget**: Configurable (`--map-tokens`, default 1K). Shows function signatures and class definitions — enough for the LLM to understand APIs without full source.

No GPU, no embedding model, no vector database, works offline. Achieves **4.3-6.5% token utilization efficiency** — highest among comparable approaches.

**Deterministic**: Yes (given same input state).

### Augment Code's Context Engine

The most ambitious approach:

- Hybrid analysis: AST + dataflow + control flow + semantic embeddings + graph neural networks
- Processes 400,000+ files, indexes commit history, PR history, external docs
- Custom embedding and retrieval models trained in pairs
- Millisecond sync with code changes

**Claimed results** (blind study, 500 PRs on Elasticsearch's 3.6M-line Java codebase):

- +12.8 overall quality vs. competitors at -13.9/-11.8
- Claude Code + Opus 4.5 saw 80% quality improvement with Context Engine MCP vs. without

Self-reported numbers. Treat with appropriate skepticism.

### Are embeddings actually better?

**The evidence is mixed**:

- **Jason Liu** (from Augment's SWE-bench work): "We explored adding various embedding-based retrieval tools, but found that for SWE-bench tasks this was not the bottleneck — grep and find were sufficient."
- **DeepMind study**: State-of-the-art embedding models achieve **less than 20% recall** on complex retrieval tasks, while BM25 (lexical search) performs "exceptionally well" on the same tasks.
- **Theoretical ceiling**: For each embedding dimension, there exists a document count beyond which the embedding cannot encode all relevant result combinations. Single-vector approaches have a built-in mathematical limit.

**When embeddings win**: Millions of files, unknown terminology, concept search across unfamiliar codebases.
**When grep wins**: Known symbols, structured code, small-to-medium repos, exact matching, deterministic requirements.
**Deterministic**: No. Results vary with model updates, quantization, floating-point precision.

---

## 4. Tree-sitter — The Parsing Backbone

### What it is

Incremental parsing library (C) that generates concrete syntax trees:

- **Incremental**: O(log n) for edits vs. O(n) for full reparse
- **Error-recovering**: Produces usable trees from syntactically invalid code
- **100+ languages**: Via grammar files
- **Query language**: S-expression patterns against tree nodes

### What builds on tree-sitter

| Tool                | Use                                           |
| ------------------- | --------------------------------------------- |
| **Aider repo-map**  | Definition/reference extraction (40+ langs)   |
| **ast-grep**        | Full AST pattern matching + rewriting         |
| **Cursor**          | AST-based code chunking for embeddings        |
| **Kiro**            | Built-in code intelligence (18 languages)     |
| **Probe**           | AST-aware search returning complete functions |
| **Codebase-Memory** | Knowledge graph construction (66 languages)   |
| **GitHub**          | Code navigation, semantic search              |

### Performance (Codebase-Memory benchmarks)

- Django (49K nodes): indexes in ~6s
- Linux kernel (2.1M nodes): indexes in ~3 minutes
- Individual queries: graph traversal <<1ms, BFS call-path tracing ~0.3ms

### The cAST paper (EMNLP 2025)

AST-based chunking improves retrieval significantly:

- Recall@5 up 4.3 points on RepoEval
- Pass@1 up 2.67 points on SWE-bench generation
- StarCoder2-7B: average 5.5 point gain on RepoEval

---

## 5. Other Approaches

### LSP (Language Server Protocol)

Live semantic model: go-to-definition, find-references, hover info, diagnostics via JSON-RPC.

- **50ms** to find all call sites vs. **45 seconds** with text search on large codebases (900x improvement)
- Returns exact matches consuming ~500 tokens vs. 2000+ for grep-based scanning
- Claude Code shipped native LSP support December 2025 (v2.0.74)
- Requires language server installation + initialization (seconds to minutes)
- Deterministic: yes

### Code Graph Databases (Sourcegraph / SCIP)

SCIP indexes are 4x smaller than equivalent LSIF payloads. Sourcegraph's philosophy: code intelligence should use parsers and search indexes, not agent hype. Achieved 30% completion acceptance rate in Cody by optimizing context as a "bin packing problem."

### Call Graph / Data Flow

- **Codebase-Memory**: Six-strategy cascading call resolution with confidence scores (0.30-0.95)
- **CodeQL**: Interprocedural data flow tracking across method boundaries
- Powerful but heavy — full call graph construction requires type resolution

---

## 6. SWE-bench Evidence

| Agent              | Search Strategy                              | SWE-bench Lite         | Cost/Issue |
| ------------------ | -------------------------------------------- | ---------------------- | ---------- |
| **Agentless**      | LLM + embeddings (hierarchical localization) | 32%                    | $0.70      |
| **Moatless Tools** | FAISS + Voyage AI embeddings + MCTS          | 39%                    | $0.14      |
| **SweRank**        | Custom embedding model (retrieve-and-rerank) | Beats Claude-3.5 agent | —          |

**Key insight**: The relationship between search sophistication and end-to-end performance is weak on current benchmarks. For SWE-bench-scale repositories, grep is sufficient because repos are small and code is structured. Agent persistence compensates for unsophisticated search.

**Contamination warning**: Models are 3-6x more accurate on SWE-bench-Verified than on decontaminated sets. Top models score ~23% on SWE-bench Pro vs. 70%+ on Verified.

---

## 7. The Emerging Consensus: Layered Search

The 2025-2026 industry direction converges on **layered search**:

```
Layer 1: Ripgrep           — fast text search (20ms, zero setup)
Layer 2: Tree-sitter/LSP   — structural understanding (50ms, light setup)
Layer 3: ast-grep           — pattern matching on AST (500ms, no setup)
Layer 4: Embeddings         — concept search (200ms query, hours to index)
Layer 5: Graph databases    — full code intelligence (ms query, minutes to index)
```

Each layer adds capability at the cost of complexity. Hybrid retrieval combining BM25 + dense embeddings achieves **15-30% better recall** than either alone.

**Probe** (probelabs/probe) represents the "third path": ripgrep speed + tree-sitter AST parsing. Returns complete functions/classes rather than text fragments. Zero setup, fully local.

**Codebase-Memory**: Tree-sitter knowledge graph in a single C binary with SQLite. Achieves 83% answer quality vs. 92% for file-exploration agents at **10x fewer tokens** and **2.1x fewer tool calls**.

---

## Summary

| Approach              | Latency        | Indexing   | Deterministic | Best For                       | Worst For          |
| --------------------- | -------------- | ---------- | ------------- | ------------------------------ | ------------------ |
| **Ripgrep**           | 20-50ms        | None       | Yes           | Known symbols, exact match     | Concept search     |
| **ast-grep**          | 0.5-1s         | None       | Yes           | Structural patterns            | Simple text search |
| **Embeddings**        | 50-200ms query | Hours      | No            | Concept search, huge codebases | Exact symbols      |
| **Tree-sitter graph** | <<1ms query    | Seconds    | Yes           | Dependencies, call chains      | Full text search   |
| **LSP**               | ~50ms          | Background | Yes           | Go-to-def, find-refs           | Setup overhead     |
| **Code graph DB**     | ms query       | Minutes    | Yes           | Enterprise navigation          | Small repos        |

The biggest opportunity for vigiles: tree-sitter-based structural understanding powers both `check()` assertions (ast-grep) and smarter type generation (dependency-aware). It's deterministic, fast, and requires no external services.

---

## Sources

- Boris Cherny, Latent Space podcast (May 2025) — Claude Code abandoned RAG for agentic grep
- Amazon Science (Feb 2026) — keyword search achieves 90%+ of RAG performance
- Cursor blog: "Improving Agent with Semantic Search" — 12.5% accuracy gain
- Aider blog: "Building a Better Repository Map with Tree-sitter" — PageRank approach
- Jason Liu: "Why Grep Beat Embeddings in Our SWE-bench Agent"
- cAST paper (EMNLP 2025) — AST chunking improves retrieval 4.3 points
- Codebase-Memory (arXiv 2603.27277) — 83% quality at 10x fewer tokens
- ast-grep blog: "Optimize ast-grep to Get 10X Faster"
- DeepMind — embedding models achieve <20% recall on complex retrieval
- SWE-Search (ICLR 2025) — MCTS enhancement for code agents
- SweRank — retrieve-and-rerank beats agent-based systems
- SWE-bench contamination (arXiv 2506.12286) — 3-6x accuracy inflation
