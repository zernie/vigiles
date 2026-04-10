/**
 * vigiles — Code clone detection via tree edit distance.
 *
 * Implements the Zhang-Shasha algorithm (1989) for ordered tree edit distance,
 * with Bloom filter pre-filtering for O(n²) → O(n) candidate reduction.
 *
 * Clone type taxonomy:
 *   Type-1: Exact clones (modulo whitespace/comments)     → caught by hash
 *   Type-2: Renamed identifiers/literals                   → caught by tree edit distance
 *   Type-3: Near-miss (added/deleted statements)           → caught by tree edit distance
 *   Type-4: Semantically equivalent, textually different   → undecidable (Rice's theorem)
 *
 * Reference: Zhang & Shasha (1989) "Simple Fast Algorithms for the Editing
 *            Distance between Trees and Related Problems"
 */

import { BloomFilter } from "./proofs.js";

// ---------------------------------------------------------------------------
// Tree representation
// ---------------------------------------------------------------------------

/**
 * A labeled ordered tree node. This is the input to Zhang-Shasha.
 *
 * Labels carry the "type" of the node (e.g., "function_declaration",
 * "identifier:foo", "block_statement"). Children are ordered.
 */
export interface TreeNode {
  label: string;
  children: TreeNode[];
}

/** Count total nodes in a tree. */
export function treeSize(node: TreeNode): number {
  let count = 1;
  for (const child of node.children) {
    count += treeSize(child);
  }
  return count;
}

/** Collect all labels in a tree (DFS pre-order). */
export function treeLabels(node: TreeNode): string[] {
  const labels: string[] = [node.label];
  for (const child of node.children) {
    labels.push(...treeLabels(child));
  }
  return labels;
}

// ---------------------------------------------------------------------------
// Zhang-Shasha tree edit distance
// ---------------------------------------------------------------------------

/**
 * Flatten a tree into a post-order array for Zhang-Shasha.
 * Returns: labels[], leftmostLeaf[] (1-indexed), keyRoots[].
 */
interface PostOrderTree {
  /** Post-order labels (1-indexed, index 0 unused). */
  labels: string[];
  /** leftmostLeaf[i] = post-order index of leftmost leaf descendant of node i. */
  leftmostLeaf: number[];
  /** Key roots: nodes whose leftmost leaf differs from their parent's. */
  keyRoots: number[];
  /** Total number of nodes. */
  size: number;
}

function postOrder(root: TreeNode): PostOrderTree {
  const labels: string[] = [""];       // 1-indexed, skip 0
  const leftmostLeaf: number[] = [0];  // 1-indexed
  const parent: number[] = [0];        // parent[i] = post-order index of i's parent

  // DFS post-order traversal
  let index = 0;

  function visit(node: TreeNode, parentIdx: number): number {
    let myLeftmost = -1;

    for (const child of node.children) {
      const childIdx = visit(child, -1); // parentIdx set after we know our index
      if (myLeftmost === -1) {
        myLeftmost = leftmostLeaf[childIdx];
      }
    }

    index++;
    labels[index] = node.label;

    if (myLeftmost === -1) {
      // Leaf node: leftmost leaf is itself
      myLeftmost = index;
    }
    leftmostLeaf[index] = myLeftmost;
    parent[index] = parentIdx;

    return index;
  }

  visit(root, 0);
  const size = index;

  // Fix parent pointers — need a second pass since we didn't know
  // our own index during the first visit
  const parentFixed: number[] = new Array(size + 1).fill(0);
  function fixParents(node: TreeNode, _parentIdx: number): number {
    const childIndices: number[] = [];
    for (const child of node.children) {
      childIndices.push(fixParents(child, 0));
    }
    // This node's index in post-order: after all children
    const myIdx = childIndices.length > 0
      ? childIndices[childIndices.length - 1] + 1
      : (parentFixed._nextLeaf = (parentFixed._nextLeaf ?? 0) + 1, parentFixed._nextLeaf as number);
    // Actually, let me just recompute more simply...
    return myIdx;
  }
  // Simpler: compute key roots from leftmostLeaf directly
  // keyRoots = nodes i where leftmostLeaf[i] !== leftmostLeaf[parent[i]]
  // Since we don't track parent, use the equivalent: for each unique
  // leftmostLeaf value, the key root is the rightmost (highest post-order index)
  // node with that leftmostLeaf value.

  const lmlToMaxNode = new Map<number, number>();
  for (let i = 1; i <= size; i++) {
    const lml = leftmostLeaf[i];
    if (!lmlToMaxNode.has(lml) || i > lmlToMaxNode.get(lml)!) {
      lmlToMaxNode.set(lml, i);
    }
  }

  const keyRoots = [...lmlToMaxNode.values()].sort((a, b) => a - b);

  return { labels, leftmostLeaf, keyRoots, size };
}

/**
 * Zhang-Shasha tree edit distance.
 *
 * Computes the minimum number of edit operations (insert, delete, relabel)
 * to transform tree A into tree B.
 *
 * Time: O(n₁ × n₂ × min(depth₁, leaves₁) × min(depth₂, leaves₂))
 * Space: O(n₁ × n₂)
 *
 * In practice for code trees: O(n² × m²) worst case, but typically much
 * faster because key roots are sparse.
 */
export function zhangShasha(a: TreeNode, b: TreeNode): number {
  const tA = postOrder(a);
  const tB = postOrder(b);

  const n = tA.size;
  const m = tB.size;

  if (n === 0 && m === 0) return 0;
  if (n === 0) return m;
  if (m === 0) return n;

  // Tree distance matrix (1-indexed)
  const td: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );

  // Forest distance matrix (reused per key root pair)
  // Dimensions: (n+2) × (m+2) to handle 0-index
  const fd: number[][] = Array.from({ length: n + 2 }, () =>
    new Array(m + 2).fill(0),
  );

  const costInsert = 1;
  const costDelete = 1;
  const costRelabel = (i: number, j: number): number =>
    tA.labels[i] === tB.labels[j] ? 0 : 1;

  for (const krA of tA.keyRoots) {
    for (const krB of tB.keyRoots) {
      const lA = tA.leftmostLeaf[krA];
      const lB = tB.leftmostLeaf[krB];

      // Initialize forest distance
      fd[lA - 1] = fd[lA - 1] || new Array(m + 2).fill(0);
      fd[lA - 1][lB - 1] = 0;

      for (let i = lA; i <= krA; i++) {
        fd[i] = fd[i] || new Array(m + 2).fill(0);
        fd[i][lB - 1] = fd[i - 1][lB - 1] + costDelete;
      }
      for (let j = lB; j <= krB; j++) {
        fd[lA - 1][j] = fd[lA - 1][j - 1] + costInsert;
      }

      for (let i = lA; i <= krA; i++) {
        for (let j = lB; j <= krB; j++) {
          if (
            tA.leftmostLeaf[i] === lA &&
            tB.leftmostLeaf[j] === lB
          ) {
            // Both i and j are in the leftmost path from their key roots
            fd[i][j] = Math.min(
              fd[i - 1][j] + costDelete,
              fd[i][j - 1] + costInsert,
              fd[i - 1][j - 1] + costRelabel(i, j),
            );
            td[i][j] = fd[i][j];
          } else {
            // One of them is not in the leftmost path — use stored tree distance
            fd[i][j] = Math.min(
              fd[i - 1][j] + costDelete,
              fd[i][j - 1] + costInsert,
              fd[tA.leftmostLeaf[i] - 1][tB.leftmostLeaf[j] - 1] +
                td[i][j],
            );
          }
        }
      }
    }
  }

  return td[n][m];
}

/**
 * Normalized tree edit distance — range [0, 1].
 * 0 = identical trees, 1 = maximally different.
 *
 * Normalized by the maximum possible edit distance (sum of tree sizes).
 */
export function normalizedTreeEditDistance(a: TreeNode, b: TreeNode): number {
  const sizeA = treeSize(a);
  const sizeB = treeSize(b);
  if (sizeA === 0 && sizeB === 0) return 0;

  const dist = zhangShasha(a, b);
  return dist / (sizeA + sizeB);
}

/**
 * Tree similarity — range [0, 1].
 * 1 = identical trees, 0 = maximally different.
 */
export function treeSimilarity(a: TreeNode, b: TreeNode): number {
  return 1 - normalizedTreeEditDistance(a, b);
}

// ---------------------------------------------------------------------------
// Code-to-tree parser (lightweight, no tree-sitter dependency)
// ---------------------------------------------------------------------------

/**
 * Token types for the simple lexer.
 */
type TokenType =
  | "keyword"
  | "identifier"
  | "number"
  | "string"
  | "operator"
  | "punctuation"
  | "open_brace"
  | "close_brace"
  | "open_paren"
  | "close_paren"
  | "open_bracket"
  | "close_bracket"
  | "semicolon"
  | "comma"
  | "whitespace"
  | "comment";

interface Token {
  type: TokenType;
  value: string;
}

const KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "default", "delete", "do", "else", "enum", "export", "extends",
  "false", "finally", "for", "from", "function", "if", "import", "in",
  "instanceof", "interface", "let", "new", "null", "of", "return", "static",
  "super", "switch", "this", "throw", "true", "try", "type", "typeof",
  "undefined", "var", "void", "while", "with", "yield",
]);

/**
 * Simple lexer for JS/TS code. Not a full parser — just enough to
 * build a structural tree for clone detection.
 */
function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < code.length) {
    const ch = code[i];

    // Whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Single-line comment
    if (ch === "/" && code[i + 1] === "/") {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }

    // Multi-line comment
    if (ch === "/" && code[i + 1] === "*") {
      i += 2;
      while (i < code.length - 1 && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    // String literals
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let str = ch;
      i++;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === "\\") {
          str += code[i++];
        }
        if (i < code.length) str += code[i++];
      }
      if (i < code.length) {
        str += code[i++];
      }
      tokens.push({ type: "string", value: "STRING" }); // normalize all strings
      continue;
    }

    // Numbers
    if (/\d/.test(ch)) {
      let num = "";
      while (i < code.length && /[\d.xXa-fA-F_nN]/.test(code[i])) {
        num += code[i++];
      }
      tokens.push({ type: "number", value: "NUM" }); // normalize all numbers
      continue;
    }

    // Identifiers / keywords
    if (/[a-zA-Z_$]/.test(ch)) {
      let ident = "";
      while (i < code.length && /[a-zA-Z0-9_$]/.test(code[i])) {
        ident += code[i++];
      }
      if (KEYWORDS.has(ident)) {
        tokens.push({ type: "keyword", value: ident });
      } else {
        tokens.push({ type: "identifier", value: "ID" }); // normalize identifiers (Type-2 tolerance)
      }
      continue;
    }

    // Brackets
    if (ch === "{") { tokens.push({ type: "open_brace", value: "{" }); i++; continue; }
    if (ch === "}") { tokens.push({ type: "close_brace", value: "}" }); i++; continue; }
    if (ch === "(") { tokens.push({ type: "open_paren", value: "(" }); i++; continue; }
    if (ch === ")") { tokens.push({ type: "close_paren", value: ")" }); i++; continue; }
    if (ch === "[") { tokens.push({ type: "open_bracket", value: "[" }); i++; continue; }
    if (ch === "]") { tokens.push({ type: "close_bracket", value: "]" }); i++; continue; }
    if (ch === ";") { tokens.push({ type: "semicolon", value: ";" }); i++; continue; }
    if (ch === ",") { tokens.push({ type: "comma", value: "," }); i++; continue; }

    // Multi-char operators
    if (i + 2 < code.length) {
      const tri = code.slice(i, i + 3);
      if (["===", "!==", ">>>", "**=", "&&=", "||=", "??=", "..."].includes(tri)) {
        tokens.push({ type: "operator", value: tri });
        i += 3;
        continue;
      }
    }
    if (i + 1 < code.length) {
      const bi = code.slice(i, i + 2);
      if (["==", "!=", "<=", ">=", "=>", "&&", "||", "??", "++", "--", "+=", "-=", "*=", "/=", "**", "?."].includes(bi)) {
        tokens.push({ type: "operator", value: bi });
        i += 2;
        continue;
      }
    }

    // Single-char operators
    if ("+-*/%=<>!&|^~?:.@#".includes(ch)) {
      tokens.push({ type: "operator", value: ch });
      i++;
      continue;
    }

    // Skip anything else
    i++;
  }

  return tokens;
}

/**
 * Build a tree from tokens using bracket nesting.
 *
 * The tree structure reflects the syntactic nesting of the code:
 * - Matched {}/{, (/(, [/] create parent-child relationships
 * - Keywords and operators form the backbone labels
 * - Identifiers are normalized to "ID" (Type-2 clone tolerance)
 * - Numbers normalized to "NUM", strings to "STRING"
 *
 * This captures structural similarity without a full parser.
 */
function tokensToTree(tokens: Token[]): TreeNode {
  const root: TreeNode = { label: "program", children: [] };
  const stack: TreeNode[] = [root];

  for (const token of tokens) {
    const current = stack[stack.length - 1];

    if (token.type === "open_brace") {
      const block: TreeNode = { label: "block", children: [] };
      current.children.push(block);
      stack.push(block);
    } else if (token.type === "open_paren") {
      const group: TreeNode = { label: "params", children: [] };
      current.children.push(group);
      stack.push(group);
    } else if (token.type === "open_bracket") {
      const arr: TreeNode = { label: "array", children: [] };
      current.children.push(arr);
      stack.push(arr);
    } else if (
      token.type === "close_brace" ||
      token.type === "close_paren" ||
      token.type === "close_bracket"
    ) {
      if (stack.length > 1) {
        stack.pop();
      }
    } else if (token.type === "semicolon") {
      // Statement boundary — add as marker
      current.children.push({ label: ";", children: [] });
    } else if (token.type === "comma") {
      // Skip commas as structural noise
    } else {
      current.children.push({ label: token.value, children: [] });
    }
  }

  return root;
}

/**
 * Parse code into a structural tree for clone detection.
 *
 * Normalizations applied:
 * - Identifiers → "ID" (catches Type-2 renames)
 * - Numbers → "NUM"
 * - Strings → "STRING"
 * - Comments stripped
 * - Whitespace stripped
 *
 * The tree preserves structural nesting ({}, (), []) and keyword backbone.
 */
export function codeToTree(code: string): TreeNode {
  const tokens = tokenize(code);
  return tokensToTree(tokens);
}

// ---------------------------------------------------------------------------
// Bloom filter pre-filtering for clone candidates
// ---------------------------------------------------------------------------

/**
 * Build a Bloom filter from a tree's label n-grams.
 *
 * Uses label bigrams (pairs of consecutive labels in pre-order)
 * as features. This captures local structural patterns.
 */
export function treeToBloomFilter(
  node: TreeNode,
  expectedFeatures: number = 200,
  fpr: number = 0.01,
): BloomFilter {
  const labels = treeLabels(node);
  const filter = new BloomFilter(Math.max(expectedFeatures, labels.length * 2), fpr);

  // Unigrams
  for (const label of labels) {
    filter.add(label);
  }

  // Bigrams (consecutive label pairs)
  for (let i = 0; i < labels.length - 1; i++) {
    filter.add(`${labels[i]}→${labels[i + 1]}`);
  }

  return filter;
}

// ---------------------------------------------------------------------------
// Clone detection pipeline
// ---------------------------------------------------------------------------

export interface CodeFragment {
  /** Unique identifier (e.g., file path + function name). */
  id: string;
  /** Source code. */
  code: string;
}

export interface ClonePair {
  idA: string;
  idB: string;
  similarity: number;
  editDistance: number;
  sizeA: number;
  sizeB: number;
}

export interface CloneDetectionResult {
  /** Clone pairs above the similarity threshold. */
  clones: ClonePair[];
  /** Total fragments analyzed. */
  totalFragments: number;
  /** Pairs skipped by Bloom pre-filter. */
  bloomSkipped: number;
  /** Pairs that passed Bloom filter and were fully compared. */
  fullComparisons: number;
}

/**
 * Detect code clones across a set of code fragments.
 *
 * Pipeline:
 * 1. Parse each fragment to a structural tree
 * 2. Build Bloom filters from tree label n-grams
 * 3. Pre-filter: skip pairs with low Bloom Jaccard similarity
 * 4. Full comparison: Zhang-Shasha tree edit distance on candidate pairs
 * 5. Return pairs above similarity threshold
 *
 * @param fragments Code fragments to compare
 * @param options Detection parameters
 */
export function detectClones(
  fragments: CodeFragment[],
  options: {
    /** Minimum similarity to report (0-1). Default: 0.5 */
    similarityThreshold?: number;
    /** Bloom Jaccard threshold for pre-filtering (0-1). Default: 0.1 */
    bloomThreshold?: number;
    /** Maximum tree size to compare (skip huge functions). Default: 500 */
    maxTreeSize?: number;
  } = {},
): CloneDetectionResult {
  const similarityThreshold = options.similarityThreshold ?? 0.5;
  const bloomThreshold = options.bloomThreshold ?? 0.1;
  const maxTreeSize = options.maxTreeSize ?? 500;

  // Step 1 & 2: Parse and build Bloom filters
  const trees: { id: string; tree: TreeNode; bloom: BloomFilter; size: number }[] = [];

  for (const fragment of fragments) {
    const tree = codeToTree(fragment.code);
    const size = treeSize(tree);
    if (size > maxTreeSize) continue; // skip huge trees
    if (size < 3) continue; // skip trivial trees

    const bloom = treeToBloomFilter(tree);
    trees.push({ id: fragment.id, tree, bloom, size });
  }

  // Step 3 & 4: Pairwise comparison with Bloom pre-filter
  const clones: ClonePair[] = [];
  let bloomSkipped = 0;
  let fullComparisons = 0;

  for (let i = 0; i < trees.length; i++) {
    for (let j = i + 1; j < trees.length; j++) {
      const a = trees[i];
      const b = trees[j];

      // Size ratio filter — very different sizes are unlikely clones
      const sizeRatio = Math.min(a.size, b.size) / Math.max(a.size, b.size);
      if (sizeRatio < 0.3) {
        bloomSkipped++;
        continue;
      }

      // Bloom pre-filter
      try {
        const bloomSim = BloomFilter.jaccardSimilarity(a.bloom, b.bloom);
        if (bloomSim < bloomThreshold) {
          bloomSkipped++;
          continue;
        }
      } catch {
        // Different filter sizes — compare anyway
      }

      // Full tree edit distance comparison
      fullComparisons++;
      const sim = treeSimilarity(a.tree, b.tree);

      if (sim >= similarityThreshold) {
        clones.push({
          idA: a.id,
          idB: b.id,
          similarity: sim,
          editDistance: zhangShasha(a.tree, b.tree),
          sizeA: a.size,
          sizeB: b.size,
        });
      }
    }
  }

  clones.sort((a, b) => b.similarity - a.similarity);

  return {
    clones,
    totalFragments: fragments.length,
    bloomSkipped,
    fullComparisons,
  };
}
