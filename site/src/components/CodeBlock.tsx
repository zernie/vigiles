import { Highlight, type PrismTheme } from "prism-react-renderer";

/**
 * The one code block on the site — highlighted, and wrapping.
 *
 * THEME: the Oceanic Material token hues on a warm near-black ground, defined
 * here as data rather than pulled from a theme package. prism-react-renderer
 * takes a plain object, so the palette IS the config; a second dependency would
 * buy nothing. Code stays dark on the light page (#1B1A17 ground, #E9E4D8 text,
 * #8F897C comment; #6699CC blue, #99C794 green, #C594C5 purple, #F99157 orange,
 * #5FB3B3 cyan).
 *
 * 🔴 WRAPPING IS NOT COSMETIC — it is the mobile contract. `site/e2e/mobile.spec.ts`
 * asserts no visible <pre> overflows its box at 390px, and a highlighter's default is
 * to emit a wide non-wrapping <pre>. Both `whitespace-pre-wrap` and `break-words` are
 * load-bearing here: the first wraps at spaces, the second breaks the long unbroken
 * tokens (paths, URLs, `measureTriggerRate:`) that otherwise push the page sideways.
 * A previous version of these blocks used `overflow-x-auto` and bled 258px.
 */
const oceanic: PrismTheme = {
  plain: { color: "#E9E4D8", backgroundColor: "#1B1A17" },
  styles: [
    {
      types: ["comment", "prolog", "doctype", "cdata"],
      style: { color: "#8F897C", fontStyle: "italic" },
    },
    { types: ["punctuation"], style: { color: "#A7ADBA" } },
    {
      types: ["property", "tag", "constant", "symbol", "deleted"],
      style: { color: "#EC5f67" },
    },
    { types: ["boolean", "number"], style: { color: "#F99157" } },
    {
      types: ["selector", "attr-name", "string", "char", "builtin", "inserted"],
      style: { color: "#99C794" },
    },
    {
      types: ["operator", "entity", "url", "variable"],
      style: { color: "#5FB3B3" },
    },
    {
      types: ["atrule", "attr-value", "function", "class-name"],
      style: { color: "#6699CC" },
    },
    { types: ["keyword"], style: { color: "#C594C5" } },
    { types: ["regex", "important"], style: { color: "#FAC863" } },
  ],
};

export function CodeBlock({
  code,
  language = "tsx",
  className = "",
}: {
  code: string;
  language?: string;
  className?: string;
}) {
  return (
    <Highlight theme={oceanic} code={code} language={language}>
      {({ style, tokens, getLineProps, getTokenProps }) => (
        <pre
          style={style}
          className={`whitespace-pre-wrap break-words rounded-xl border border-border/60 p-5 font-mono text-xs leading-relaxed ${className}`}
        >
          {tokens.map((line, i) => (
            <div key={i} {...getLineProps({ line })}>
              {line.map((token, k) => (
                <span key={k} {...getTokenProps({ token })} />
              ))}
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  );
}
