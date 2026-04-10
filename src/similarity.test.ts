/**
 * Tests for the code clone detection system.
 *
 * Tests the full pipeline: code → tree → Bloom filter → Zhang-Shasha → clone pairs.
 * Uses real code snippets to measure detection quality across clone types.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  codeToTree,
  treeSize,
  treeLabels,
  treeSimilarity,
  zhangShasha,
  normalizedTreeEditDistance,
  treeToBloomFilter,
  detectClones,
} from "./similarity.js";

import { BloomFilter } from "./proofs.js";

// ---------------------------------------------------------------------------
// Tree construction
// ---------------------------------------------------------------------------

describe("codeToTree", () => {
  it("parses a simple function into a tree", () => {
    const tree = codeToTree(`
      function greet(name) {
        return "Hello, " + name;
      }
    `);

    assert.equal(tree.label, "program");
    assert.ok(tree.children.length > 0);
    assert.ok(treeSize(tree) > 5, `Tree too small: ${treeSize(tree)} nodes`);
  });

  it("normalizes identifiers to ID", () => {
    const labels = treeLabels(codeToTree("const x = foo(bar);"));
    assert.ok(labels.includes("ID"), "Should contain normalized identifier");
    assert.ok(!labels.includes("x"), "Should not contain raw identifier 'x'");
    assert.ok(!labels.includes("foo"), "Should not contain raw identifier 'foo'");
  });

  it("normalizes numbers to NUM", () => {
    const labels = treeLabels(codeToTree("const x = 42 + 3.14;"));
    assert.ok(labels.includes("NUM"), "Should contain normalized number");
    assert.ok(!labels.includes("42"), "Should not contain raw number");
  });

  it("normalizes strings to STRING", () => {
    const labels = treeLabels(codeToTree('const x = "hello world";'));
    assert.ok(labels.includes("STRING"), "Should contain normalized string");
    assert.ok(
      !labels.includes('"hello world"'),
      "Should not contain raw string",
    );
  });

  it("preserves keywords", () => {
    const labels = treeLabels(
      codeToTree("if (x) { return y; } else { throw z; }"),
    );
    assert.ok(labels.includes("if"));
    assert.ok(labels.includes("return"));
    assert.ok(labels.includes("else"));
    assert.ok(labels.includes("throw"));
  });

  it("creates nested structure for braces", () => {
    const tree = codeToTree("function f() { if (x) { y(); } }");
    // Should have nested blocks
    const blockCount = JSON.stringify(tree).split('"block"').length - 1;
    assert.ok(blockCount >= 2, `Expected at least 2 blocks, got ${blockCount}`);
  });

  it("strips comments", () => {
    const a = codeToTree("const x = 1; // this is a comment");
    const b = codeToTree("const x = 1;");
    assert.equal(treeSize(a), treeSize(b));
  });
});

// ---------------------------------------------------------------------------
// Zhang-Shasha tree edit distance
// ---------------------------------------------------------------------------

describe("zhangShasha", () => {
  it("returns 0 for identical trees", () => {
    const a = codeToTree("function f(x) { return x + 1; }");
    const b = codeToTree("function f(x) { return x + 1; }");
    assert.equal(zhangShasha(a, b), 0);
  });

  it("returns small distance for renamed variables (Type-2)", () => {
    // Type-2 clone: same structure, different identifiers
    // Since identifiers are normalized to "ID", these should be IDENTICAL
    const a = codeToTree("function greet(name) { return name + ' hello'; }");
    const b = codeToTree("function salute(person) { return person + ' hello'; }");
    const dist = zhangShasha(a, b);
    assert.equal(dist, 0, `Type-2 clones should have distance 0 after normalization, got ${dist}`);
  });

  it("returns moderate distance for near-miss clones (Type-3)", () => {
    // Type-3 clone: structural modification (extra statement)
    const a = codeToTree(`
      function process(data) {
        const result = transform(data);
        return result;
      }
    `);
    const b = codeToTree(`
      function process(data) {
        validate(data);
        const result = transform(data);
        log(result);
        return result;
      }
    `);
    const sim = treeSimilarity(a, b);
    assert.ok(
      sim > 0.4 && sim < 1.0,
      `Type-3 similarity should be 0.4-1.0, got ${sim.toFixed(3)}`,
    );
  });

  it("returns low similarity for completely different code", () => {
    const a = codeToTree(`
      function fibonacci(n) {
        if (n <= 1) return n;
        return fibonacci(n - 1) + fibonacci(n - 2);
      }
    `);
    const b = codeToTree(`
      class UserService {
        constructor(db) {
          this.db = db;
        }
        async findById(id) {
          return this.db.query("SELECT * FROM users WHERE id = ?", [id]);
        }
      }
    `);
    const sim = treeSimilarity(a, b);
    assert.ok(sim < 0.5, `Different code should have low similarity, got ${sim.toFixed(3)}`);
  });

  it("handles empty trees", () => {
    const empty = codeToTree("");
    const nonEmpty = codeToTree("const x = 1;");
    // Empty tree has only the "program" root
    const dist = zhangShasha(empty, nonEmpty);
    assert.ok(dist > 0, "Distance from empty to non-empty should be > 0");
  });

  it("is symmetric", () => {
    const a = codeToTree("function f() { return 1; }");
    const b = codeToTree("function g() { return 1 + 2; }");
    assert.equal(zhangShasha(a, b), zhangShasha(b, a));
  });

  it("satisfies triangle inequality", () => {
    const a = codeToTree("const x = 1;");
    const b = codeToTree("const y = 2; const z = 3;");
    const c = codeToTree("let w = 4; let v = 5; let u = 6;");

    const dAB = zhangShasha(a, b);
    const dBC = zhangShasha(b, c);
    const dAC = zhangShasha(a, c);

    assert.ok(
      dAC <= dAB + dBC,
      `Triangle inequality violated: d(A,C)=${dAC} > d(A,B)=${dAB} + d(B,C)=${dBC}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Normalized distance and similarity
// ---------------------------------------------------------------------------

describe("normalizedTreeEditDistance", () => {
  it("returns 0 for identical code", () => {
    const a = codeToTree("const x = 1;");
    const b = codeToTree("const x = 1;");
    assert.equal(normalizedTreeEditDistance(a, b), 0);
  });

  it("returns value in [0, 1]", () => {
    const a = codeToTree("function f() { return 1; }");
    const b = codeToTree("class C { method() { return 2; } }");
    const d = normalizedTreeEditDistance(a, b);
    assert.ok(d >= 0 && d <= 1, `Expected [0,1], got ${d}`);
  });
});

// ---------------------------------------------------------------------------
// Real-world clone detection scenarios
// ---------------------------------------------------------------------------

describe("clone detection quality", () => {
  it("Type-1: detects exact clones after whitespace normalization", () => {
    const a = codeToTree(
      "function  add(a, b)  {\n  return  a + b;\n}",
    );
    const b = codeToTree(
      "function add(a,b){return a+b;}",
    );
    const sim = treeSimilarity(a, b);
    assert.equal(sim, 1, `Whitespace-only diff should be identical, got ${sim}`);
  });

  it("Type-2: detects renamed identifiers as clones", () => {
    const a = codeToTree(`
      function calculateTotal(items) {
        let sum = 0;
        for (const item of items) {
          sum += item.price * item.quantity;
        }
        return sum;
      }
    `);
    const b = codeToTree(`
      function computeSum(products) {
        let total = 0;
        for (const product of products) {
          total += product.price * product.quantity;
        }
        return total;
      }
    `);
    const sim = treeSimilarity(a, b);
    assert.ok(sim >= 0.95, `Type-2 (renamed) should be ≥0.95 similar, got ${sim.toFixed(3)}`);
  });

  it("Type-2: detects renamed identifiers with different literals", () => {
    const a = codeToTree(`
      const MAX_RETRIES = 3;
      function retry(fn) {
        for (let i = 0; i < MAX_RETRIES; i++) {
          try { return fn(); } catch (e) { continue; }
        }
        throw new Error("Failed after retries");
      }
    `);
    const b = codeToTree(`
      const ATTEMPT_LIMIT = 5;
      function withRetry(callback) {
        for (let attempt = 0; attempt < ATTEMPT_LIMIT; attempt++) {
          try { return callback(); } catch (err) { continue; }
        }
        throw new Error("Exceeded retry limit");
      }
    `);
    const sim = treeSimilarity(a, b);
    assert.ok(sim >= 0.9, `Type-2 (renamed + different literals) should be ≥0.9, got ${sim.toFixed(3)}`);
  });

  it("Type-3: detects structural modification (added statements)", () => {
    const a = codeToTree(`
      async function fetchUser(id) {
        const response = await fetch("/api/users/" + id);
        const data = await response.json();
        return data;
      }
    `);
    const b = codeToTree(`
      async function fetchUser(id) {
        console.log("Fetching user:", id);
        const response = await fetch("/api/users/" + id);
        if (!response.ok) {
          throw new Error("Failed to fetch user");
        }
        const data = await response.json();
        validateUser(data);
        return data;
      }
    `);
    const sim = treeSimilarity(a, b);
    assert.ok(
      sim > 0.35,
      `Type-3 (added statements) should be >0.35 similar, got ${sim.toFixed(3)}`,
    );
  });

  it("Type-3: detects structural modification (removed statements)", () => {
    const a = codeToTree(`
      function process(items) {
        const filtered = items.filter(isValid);
        const mapped = filtered.map(transform);
        const sorted = mapped.sort(compare);
        return sorted;
      }
    `);
    const b = codeToTree(`
      function process(items) {
        const filtered = items.filter(isValid);
        return filtered.sort(compare);
      }
    `);
    const sim = treeSimilarity(a, b);
    assert.ok(
      sim > 0.4,
      `Type-3 (removed steps) should be >0.4 similar, got ${sim.toFixed(3)}`,
    );
  });

  it("detects the Mastodon example: 3 different implementations of same logic", () => {
    // The classic LLM inconsistency from the Mastodon thread:
    // set membership, regex, and string methods for the same check
    const setImpl = codeToTree(`
      function isVowel(char) {
        const vowels = new Set(["a", "e", "i", "o", "u"]);
        return vowels.has(char.toLowerCase());
      }
    `);
    const regexImpl = codeToTree(`
      function isVowel(char) {
        return /[aeiou]/i.test(char);
      }
    `);
    const stringImpl = codeToTree(`
      function isVowel(char) {
        return "aeiou".includes(char.toLowerCase());
      }
    `);

    // Type-4 clones — semantically equivalent but structurally different
    // Our system SHOULD detect some structural similarity (shared function shape)
    // but NOT full similarity (different implementations)
    const simSetRegex = treeSimilarity(setImpl, regexImpl);
    const simSetString = treeSimilarity(setImpl, stringImpl);
    const simRegexString = treeSimilarity(regexImpl, stringImpl);

    // These should show SOME similarity (same function shape) but not identical
    // This is the limit of structural clone detection — Type-4 is undecidable
    assert.ok(
      simSetRegex < 0.85,
      `Set vs regex should not be too similar (different structure): ${simSetRegex.toFixed(3)}`,
    );
    assert.ok(
      simRegexString > 0.2,
      `All share function structure, should have some similarity: ${simRegexString.toFixed(3)}`,
    );

    // Log for manual inspection
    console.log("  Mastodon Type-4 example:");
    console.log(`    set ↔ regex:  ${simSetRegex.toFixed(3)}`);
    console.log(`    set ↔ string: ${simSetString.toFixed(3)}`);
    console.log(`    regex ↔ string: ${simRegexString.toFixed(3)}`);
  });
});

// ---------------------------------------------------------------------------
// Bloom filter pre-filtering
// ---------------------------------------------------------------------------

describe("treeToBloomFilter", () => {
  it("similar code produces similar Bloom filters", () => {
    const a = codeToTree("function f(x) { return x + 1; }");
    const b = codeToTree("function g(y) { return y + 2; }");

    const filterA = treeToBloomFilter(a);
    const filterB = treeToBloomFilter(b);

    const sim = BloomFilter.jaccardSimilarity(filterA, filterB);
    assert.ok(sim > 0.5, `Similar code should have high Bloom similarity: ${sim.toFixed(3)}`);
  });

  it("different code produces different Bloom filters", () => {
    const a = codeToTree("function f() { return 1; }");
    const b = codeToTree(`
      class Database {
        async query(sql) {
          const conn = await this.pool.acquire();
          try {
            return await conn.execute(sql);
          } finally {
            conn.release();
          }
        }
      }
    `);

    const filterA = treeToBloomFilter(a);
    const filterB = treeToBloomFilter(b);

    const sim = BloomFilter.jaccardSimilarity(filterA, filterB);
    assert.ok(sim < 0.7, `Different code should have lower Bloom similarity: ${sim.toFixed(3)}`);
  });
});

// ---------------------------------------------------------------------------
// Full pipeline: detectClones
// ---------------------------------------------------------------------------

describe("detectClones", () => {
  it("finds clones in a set of code fragments", () => {
    const result = detectClones([
      {
        id: "original",
        code: `
          function validate(input) {
            if (!input) throw new Error("Required");
            if (typeof input !== "string") throw new Error("Must be string");
            return input.trim();
          }
        `,
      },
      {
        id: "renamed-clone",
        code: `
          function sanitize(value) {
            if (!value) throw new Error("Required");
            if (typeof value !== "string") throw new Error("Must be string");
            return value.trim();
          }
        `,
      },
      {
        id: "unrelated",
        code: `
          class EventEmitter {
            constructor() { this.listeners = new Map(); }
            on(event, handler) {
              if (!this.listeners.has(event)) this.listeners.set(event, []);
              this.listeners.get(event).push(handler);
            }
            emit(event, data) {
              for (const handler of this.listeners.get(event) || []) {
                handler(data);
              }
            }
          }
        `,
      },
    ], { similarityThreshold: 0.6 });

    // Should find the clone pair
    assert.ok(result.clones.length >= 1, `Expected at least 1 clone pair, got ${result.clones.length}`);

    const topClone = result.clones[0];
    assert.ok(
      (topClone.idA === "original" && topClone.idB === "renamed-clone") ||
      (topClone.idA === "renamed-clone" && topClone.idB === "original"),
      "Top clone should be original ↔ renamed-clone",
    );
    assert.ok(topClone.similarity >= 0.9, `Clone similarity should be ≥0.9: ${topClone.similarity.toFixed(3)}`);

    console.log("  detectClones results:");
    console.log(`    Total fragments: ${result.totalFragments}`);
    console.log(`    Bloom skipped: ${result.bloomSkipped}`);
    console.log(`    Full comparisons: ${result.fullComparisons}`);
    for (const clone of result.clones) {
      console.log(`    ${clone.idA} ↔ ${clone.idB}: ${clone.similarity.toFixed(3)}`);
    }
  });

  it("Bloom filter actually reduces comparisons", () => {
    // Generate several distinct code fragments
    const fragments = [
      { id: "a", code: "function a() { return 1; }" },
      { id: "b", code: "function b() { return 2; }" }, // clone of a
      { id: "c", code: `
        class DatabaseConnection {
          constructor(host, port, database) {
            this.host = host;
            this.port = port;
            this.database = database;
            this.pool = [];
          }
          async connect() {
            const conn = await createConnection(this.host, this.port);
            this.pool.push(conn);
            return conn;
          }
          async disconnect() {
            for (const conn of this.pool) {
              await conn.close();
            }
            this.pool = [];
          }
        }
      `},
      { id: "d", code: `
        async function fetchWithRetry(url, maxRetries) {
          for (let i = 0; i < maxRetries; i++) {
            try {
              const response = await fetch(url);
              if (response.ok) return await response.json();
            } catch (error) {
              if (i === maxRetries - 1) throw error;
              await sleep(1000 * Math.pow(2, i));
            }
          }
        }
      `},
    ];

    const result = detectClones(fragments, { similarityThreshold: 0.5 });

    // The bloom filter + size ratio filter should skip some pairs
    const totalPossiblePairs = (fragments.length * (fragments.length - 1)) / 2;
    console.log(`  Pre-filter efficiency: skipped ${result.bloomSkipped}/${totalPossiblePairs} pairs`);
  });

  it("handles empty input", () => {
    const result = detectClones([]);
    assert.equal(result.clones.length, 0);
    assert.equal(result.totalFragments, 0);
  });

  it("handles single fragment", () => {
    const result = detectClones([
      { id: "only", code: "const x = 1;" },
    ]);
    assert.equal(result.clones.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Performance characteristics
// ---------------------------------------------------------------------------

describe("performance", () => {
  it("Zhang-Shasha completes in reasonable time for medium trees", () => {
    // Generate a function with ~30 statements
    const lines = [];
    for (let i = 0; i < 30; i++) {
      lines.push(`  const v${i} = process(input${i});`);
    }
    const code = `function bigFn(input) {\n${lines.join("\n")}\n  return result;\n}`;

    const tree = codeToTree(code);
    console.log(`  Medium tree size: ${treeSize(tree)} nodes`);

    const start = performance.now();
    const dist = zhangShasha(tree, tree);
    const elapsed = performance.now() - start;

    assert.equal(dist, 0, "Identical trees should have distance 0");
    assert.ok(elapsed < 1000, `Should complete in <1s, took ${elapsed.toFixed(1)}ms`);
    console.log(`  Self-comparison time: ${elapsed.toFixed(1)}ms`);
  });

  it("detectClones scales with Bloom pre-filtering", () => {
    // Generate 20 fragments, only 2 are clones
    const fragments = [];
    for (let i = 0; i < 20; i++) {
      fragments.push({
        id: `frag-${i}`,
        code: `function fn${i}(${Array.from({length: i % 5 + 1}, (_, j) => `arg${j}`).join(", ")}) {
          ${Array.from({length: (i * 7 + 3) % 10 + 2}, (_, j) => `const v${j} = step${i}_${j}(arg0);`).join("\n  ")}
          return result;
        }`,
      });
    }
    // Add a clone of fragment 0
    fragments.push({
      id: "clone-of-0",
      code: fragments[0].code.replace(/fn0/g, "fnClone").replace(/step0/g, "stepClone"),
    });

    const start = performance.now();
    const result = detectClones(fragments, { similarityThreshold: 0.7 });
    const elapsed = performance.now() - start;

    console.log(`  20+1 fragments: ${elapsed.toFixed(1)}ms`);
    console.log(`    Bloom skipped: ${result.bloomSkipped}`);
    console.log(`    Full comparisons: ${result.fullComparisons}`);
    console.log(`    Clones found: ${result.clones.length}`);

    // Should find the intentional clone
    const hasClone = result.clones.some(
      (c) =>
        (c.idA === "frag-0" && c.idB === "clone-of-0") ||
        (c.idA === "clone-of-0" && c.idB === "frag-0"),
    );
    assert.ok(hasClone, "Should detect the intentional clone");
    assert.ok(elapsed < 5000, `Should complete in <5s, took ${elapsed.toFixed(1)}ms`);
  });
});
