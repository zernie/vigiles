/**
 * `local/experimental-name` — a symbol the source calls EXPERIMENTAL must SAY SO
 * IN ITS NAME.
 *
 * One sentence: if an exported declaration carries the `@experimental` TSDoc tag,
 * its name must start with `experimental_`.
 *
 * WHY THIS EXISTS, measured. The prefix convention already existed —
 * `experimental_emitTool`, `experimental_parseEmitted`, `experimental_withServices`
 * were all named that way on purpose. It was written down nowhere and enforced by
 * nothing, so `skill()` shipped from `vigiles/spec` under a stable name while
 * `docs/skills.md` opened with "**`skill()` is experimental**". Prose said one
 * thing, the API said the other — the exact defect class vigiles exists to catch,
 * in vigiles. A convention that is only a habit gets violated by the next author,
 * and the reader who trusts the NAME (the thing an editor autocompletes) never
 * reads the doc that would have warned them.
 *
 * WHAT IT SUBTRACTS: the ability to mark something experimental in one place and
 * stable in another. Experimentality is declared ONCE, in TSDoc, and the name is
 * checked against it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY AN ESLINT RULE AND NOT THE SCRIPT IT REPLACES
 *
 * This began as `scripts/check-experimental-naming.mjs`, a standalone pass over
 * regex-matched declaration lines, gated by `npm run experimental:check`. Two
 * things were wrong with that shape and only one of them was obvious.
 *
 * The obvious one: it hand-rolled a parser. `VALUE_DECL` was a regex against a
 * single line, so it could not see a declaration whose modifiers wrapped, and
 * `tagRe` walked backwards through lines guessing where the doc comment started.
 * ESLint hands us the AST and the attached comments. Same class as this repo's
 * own rule about parsing markdown with a parser instead of regexes: a hand-rolled
 * matcher over structured input is a deferred defect, and this one had already
 * shipped two — a tag with prose after it was invisible for a while (2 of 8
 * `@experimental` declarations and 31 of 39 `@internal` ones), and a bare opt-out
 * marker read as an explained one.
 *
 * The less obvious one, and the reason the port was blocked until now: the script
 * needed `api-surface/*.api.md` to decide what was PUBLIC, because internal
 * symbols were exempt. That exemption is what made it cross-file — and it also
 * contradicted the script's own stated rationale, that "the reader who trusts the
 * NAME never opens the doc". An internal reader is a reader. Dropping the
 * exemption removes the api reports from the equation entirely, and what is left
 * is jsdoc + name, both of which live in one file.
 *
 * 🔴 That drop was only SAFE after a separate change, and the order matters. The
 * six compiled-hook entry points used to be declared unprefixed and gain the
 * prefix at their re-export in `src/entries/hook.ts` — so at the declaration site, 14
 * tagged symbols looked like violations, and a per-file rule would have opened at
 * 14 false findings and been switched off within the day. The de-aliasing landed
 * first (one spelling per symbol, everywhere). Re-measured after it, on the whole
 * of `src/`, with no exemption at all: **22 tagged exported value declarations,
 * 0 without the prefix.** The rule turns on silent.
 *
 * THE THREE EXPORT PATHS, all covered — because a rule that policed one of them
 * while claiming to police exports would be worse than one honest about a narrow
 * scope: the overstatement is what stops anyone looking. Each was a separate hole
 * and each was found by a reviewer, not by me:
 *   1. `export const x` / `export function x`  — the declaration form;
 *   2. `export { x }` / `export { experimental_x as x }` — specifiers, including a
 *      tagged local declared separately (judged at `Program:exit`, since the export
 *      may legally precede the declaration);
 *   3. `export default function x() {}` — visited by a different node type entirely.
 *
 * ⚠️ The one case it cannot cover: an ANONYMOUS default (`export default () => {}`)
 * has no name to carry a marker. That is a limit of a name-based convention, not a
 * gap in this rule, and it is stated rather than left as unexplained silence.
 *
 * SCOPE: value declarations only (`function` / `const` / `let` / `var` / `class`).
 * Types and interfaces are out, deliberately and by measurement: the convention
 * only ever applied to callables, and the surface before the gate paired
 * `experimental_startServices` with a plain `ServiceSpec`, `ServiceHandle`,
 * `ContainerRuntime`. Pulling types in would have opened with 6 cosmetic renames
 * against 1 real finding, and a gate that arrives 86% noise is muted the same day.
 *
 * A `@module` tag documents the FILE, not one symbol — a file-level
 * `@module vigiles/eval (services)` must not condemn every export beneath it.
 *
 * OPT OUT on the declaration, with a reason on the SAME line:
 *   `vigiles:experimental-name-ok <why>`
 * The same-line requirement is not fussiness: `\s+\S` is satisfied by a newline
 * plus the JSDoc continuation `*`, so a bare marker followed by any further tag
 * would read as "explained".
 */

const PREFIX = "experimental_";
const ALLOW = /vigiles:experimental-name-ok[^\S\n]+\S/;

/** A tag with or without prose after it — real tags carry prose. */
const tagRe = (tag) => new RegExp(`^\\s*\\*?\\s*@${tag}\\b`, "m");

/**
 * Every identifier a binding target introduces, walking destructuring patterns.
 *
 * ⚠️ `export const { widget } = source` is a real export of a real name, and the
 * first version of this filtered to `id.type === "Identifier"` and returned
 * nothing for it — so a tagged callable shipped under a stable-looking name while
 * the rule claimed to cover exported `const`. Object patterns, array patterns,
 * defaults and rest elements all bind names; none of them are Identifiers at the
 * top.
 */
function bindingIds(target, out = []) {
  switch (target?.type) {
    case "Identifier":
      out.push(target);
      break;
    case "ObjectPattern":
      for (const prop of target.properties) {
        bindingIds(
          prop.type === "RestElement" ? prop.argument : prop.value,
          out,
        );
      }
      break;
    case "ArrayPattern":
      for (const el of target.elements) if (el) bindingIds(el, out);
      break;
    case "AssignmentPattern": // `{ widget = fallback }`
      bindingIds(target.left, out);
      break;
    case "RestElement":
      bindingIds(target.argument, out);
      break;
    default:
      break;
  }
  return out;
}

/** The declared names of an exported statement, or [] if it declares no value. */
function declaredNames(node) {
  if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
    return node.id ? [node.id] : [];
  }
  if (node.type === "VariableDeclaration") {
    return node.declarations.flatMap((d) => bindingIds(d.id));
  }
  return [];
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "an exported declaration tagged @experimental must be named experimental_*",
    },
    schema: [],
    messages: {
      // `experimental_` is spelled literally rather than passed as data: a
      // placeholder for a constant is a placeholder someone can forget to fill,
      // and the first test written against this message did exactly that.
      unprefixed:
        "`{{name}}` is tagged @experimental but is not named `experimental_{{name}}`. " +
        "The tag warns a reader who opens the doc; the name warns the one who does not — " +
        "and that is most of them. Rename it, or opt out on the declaration with " +
        "`vigiles:experimental-name-ok <reason>`.",
      aliasedAway:
        "this re-export renames `{{local}}` to `{{exported}}`, stripping the " +
        "`experimental_` prefix. Consumers would then call an unstable API through " +
        "a stable-looking name — the exact defect the prefix exists to prevent, and " +
        "the one that made a marker survive at 0 of 5 call sites when it was done at " +
        "an import. Export the prefixed spelling, or, if this IS a deliberate " +
        "compatibility alias, say so with `@deprecated` on the specifier (or " +
        "`vigiles:experimental-name-ok <reason>`).",
      // A separate message on purpose: nothing is being RENAMED here, so the
      // aliasing wording would read as nonsense ("renames `widget` to `widget`").
      // The defect is the same — an unstable callable reaching consumers under a
      // stable-looking name — but the author's fix is different: rename the
      // declaration, rather than stop aliasing at the export.
      exportedTaggedLocal:
        "`{{local}}` is tagged @experimental and is exported here, so it must be " +
        "named `experimental_{{local}}`. Declaring it without the prefix and " +
        "exporting it separately reaches consumers exactly as an aliased " +
        "re-export would — the declaration simply never had the marker to strip. " +
        "Rename the declaration, or opt out with " +
        "`vigiles:experimental-name-ok <reason>`.",
    },
  },
  create(context) {
    const source = context.sourceCode;

    /**
     * Locals declared WITHOUT `export` but tagged `@experimental`, e.g.
     *
     *   /** @experimental *\/
     *   const widget = () => {};
     *   export { widget };
     *
     * 🔴 A SECOND HOLE IN THE SPECIFIER PATH, found by the same reviewer one
     * round after the first. Closing the aliasing case was not enough: that
     * check only fires when the LOCAL already carries the prefix, so a tagged
     * declaration that never had it — legal TypeScript, and the ordinary shape
     * when declarations and exports are separated — reached consumers under a
     * stable-looking name with nothing complaining. The declaration branch never
     * sees it either, because the declaration has no `export` modifier.
     *
     * Collected during traversal and judged at `Program:exit`, because
     * `export { widget }` may legally precede the declaration it names.
     */
    const taggedLocals = new Set();
    /** Specifier checks deferred until `taggedLocals` is complete. */
    const pending = [];

    const isTagged = (node) => {
      const doc = source
        .getCommentsBefore(node)
        .map((c) => c.value)
        .join("\n");
      if (!tagRe("experimental").test(doc)) return false;
      if (tagRe("module").test(doc)) return false;
      if (ALLOW.test(doc)) return false;
      return true;
    };

    return {
      "VariableDeclaration, FunctionDeclaration, ClassDeclaration"(node) {
        // Only bare declarations; the exported form is handled below.
        if (node.parent?.type === "ExportNamedDeclaration") return;
        if (node.parent?.type === "ExportDefaultDeclaration") return;
        if (!isTagged(node)) return;

        // 🔴 MODULE SCOPE ONLY, and this was a FALSE POSITIVE before — the worse
        // kind of defect for a rule wired at `error`. Matching by NAME alone, a
        // tagged local inside some function body would poison the set, and an
        // unrelated top-level `widget` exported elsewhere in the file got
        // reported. That fails mandatory lint on valid code, which is how a rule
        // gets switched off entirely rather than fixed.
        //
        // The fix is to stop matching names and require the declaration to sit at
        // MODULE LEVEL, which is the only place an `export { … }` can be naming.
        //
        // ⚠️ Deliberately `node.parent`, not `sourceCode.getScope(node)`. For a
        // FunctionDeclaration, getScope returns the scope the function CREATES,
        // not the one its binding lives in — so a top-level `function widget() {}`
        // reported `function`/its own block and the check rejected it. That broke
        // the hoisting case and was caught by its test, which is exactly what that
        // test is for. The parent of a module-level statement is the Program.
        //
        // Known and accepted: a `var` or function declared inside a top-level
        // BLOCK hoists to module scope and is not tracked here. That errs toward
        // SILENCE, which is the correct direction for a rule wired at `error` —
        // a miss costs a detection, a false positive costs the build.
        if (node.parent?.type !== "Program") return;

        for (const id of declaredNames(node)) taggedLocals.add(id.name);
      },

      "Program:exit"() {
        for (const p of pending) {
          if (p.local.startsWith(PREFIX)) continue; // already reported inline
          if (!taggedLocals.has(p.local)) continue;
          context.report({
            node: p.node,
            messageId: "exportedTaggedLocal",
            data: { local: p.local },
          });
        }
      },

      /**
       * `export default function widget() {}` — the THIRD export path, and the
       * third hole found in this rule by the same reviewer. `ExportNamedDeclaration`
       * never fires for it, so a tagged callable shipped unprefixed while both this
       * rule's own header and STABILITY.md claimed every exported declaration was
       * checked. A rule that overstates its coverage is worse than one that states
       * a narrow scope honestly, because the overstatement is what stops anyone
       * looking.
       *
       * An ANONYMOUS default (`export default function () {}`, `export default
       * () => {}`) has no name to prefix, so there is nothing to report — the
       * marker cannot live at a call site that names nothing. That is a real gap
       * in what a name-based convention can promise, and it is a property of the
       * convention rather than of this rule.
       */
      ExportDefaultDeclaration(node) {
        const d = node.declaration;
        // `export default widget;` — the declaration and its tag sit ELSEWHERE
        // in the file, so this statement carries no tag of its own and the
        // inline path below finds nothing. Recorded like an export specifier and
        // judged at `Program:exit`, once the tagged locals are known.
        //
        // 🔴 FOUND BY THE CORPUS, not by review (#170). It is the same shape the
        // rule already learned for `export { x }` in an earlier round — a tagged
        // local exported by a later statement — and it went unnamed anyway,
        // which is precisely the argument for enumerating against the grammar
        // instead of patching per report.
        if (d?.type === "Identifier") {
          pending.push({ node: d, local: d.name });
          return;
        }
        const id =
          (d?.type === "FunctionDeclaration" ||
            d?.type === "ClassDeclaration") &&
          d.id
            ? d.id
            : null;
        if (!id) return;
        if (id.name.startsWith(PREFIX)) return;
        if (!isTagged(node)) return;
        const line = source.lines[id.loc.start.line - 1] ?? "";
        if (ALLOW.test(line)) return;
        context.report({
          node: id,
          messageId: "unprefixed",
          data: { name: id.name },
        });
      },

      ExportNamedDeclaration(node) {
        if (!node.declaration) {
          // `export { x }` / `export { experimental_x as x } from "…"`.
          //
          // 🔴 THIS BRANCH USED TO BE A BARE `return`, and that was a hole in the
          // middle of the rule's own thesis. The prefix is supposed to reach every
          // CALL SITE; a barrel that re-exports `experimental_widget as widget`
          // hands consumers a stable-looking name for an unstable API, which is
          // precisely the aliasing this rule was written after — measured at 0 of 5
          // call sites surviving when the same trick was done at an import. Skipping
          // every specifier form meant the rule policed declarations and ignored the
          // one construct that can undo them. Found by a reviewer, in the same PR
          // that introduced the rule.
          //
          // A deliberate compatibility alias is legitimate and common — the whole
          // point of a deprecation window is to export the old spelling for one
          // major. Those carry `@deprecated` on the specifier, which is both the
          // opt-out and the documentation, so no second marker is needed.
          for (const spec of node.specifiers ?? []) {
            if (spec.type !== "ExportSpecifier") continue;
            const local = spec.local.name ?? spec.local.value;
            const exported = spec.exported.name ?? spec.exported.value;
            if (typeof local !== "string" || typeof exported !== "string")
              continue;
            if (exported.startsWith(PREFIX)) continue;
            if (!local.startsWith(PREFIX)) {
              // Might be a tagged local declared separately — decidable only once
              // the whole file has been walked. `export { x } from "./y.js"` has a
              // source, so its local is another module's name and never ours.
              if (!node.source) {
                const near = source
                  .getCommentsBefore(spec)
                  .map((c) => c.value)
                  .join("\n");
                if (!tagRe("deprecated").test(near) && !ALLOW.test(near)) {
                  pending.push({ node: spec, local, exported });
                }
              }
              continue;
            }
            const near = source
              .getCommentsBefore(spec)
              .map((c) => c.value)
              .join("\n");
            if (tagRe("deprecated").test(near)) continue;
            if (ALLOW.test(near)) continue;
            const line = source.lines[spec.loc.start.line - 1] ?? "";
            if (ALLOW.test(line)) continue;
            context.report({
              node: spec,
              messageId: "aliasedAway",
              data: { local, exported },
            });
          }
          return;
        }
        const names = declaredNames(node.declaration);
        if (names.length === 0) return;

        const comments = source.getCommentsBefore(node);
        const doc = comments.map((c) => c.value).join("\n");
        if (!tagRe("experimental").test(doc)) return;
        if (tagRe("module").test(doc)) return;
        if (ALLOW.test(doc)) return;

        for (const id of names) {
          if (id.name.startsWith(PREFIX)) continue;
          // A same-line trailing marker also opts out.
          const line = source.lines[id.loc.start.line - 1] ?? "";
          if (ALLOW.test(line)) continue;
          context.report({
            node: id,
            messageId: "unprefixed",
            data: { name: id.name },
          });
        }
      },
    };
  },
};
