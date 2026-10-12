export const HOOK_CHECK_REF = ".vigiles/hook-check.sh";
export type HookCommandShape =
  | { readonly kind: "compiled"; readonly files: readonly string[] }
  | { readonly kind: "script"; readonly file: string }
  | { readonly kind: "opaque" };
export function hookCommandShape(
  _command: string,
  _rootTokens: readonly string[],
): HookCommandShape {
  return { kind: "opaque" };
}
