/**
 * `check.hook` (named `hookFired` before v53) has ONE meaning (zernie/vigiles#502): the check. The boolean
 * predicate that shared the name was shadowed by it, while the docs still showed
 * `hookFired(trace, "PreToolUse")` — so a JavaScript caller got a Check object,
 * which is always truthy, and every hook "fired". These lines keep the
 * documented two-argument call, and reading the check as a boolean, compile
 * errors.
 */
import { check, type Trace } from "vigiles";

const { hook } = check;

declare const trace: Trace;

// The check: one argument, a verdict through `.eval`.
const fired: boolean = hook("PreToolUse").eval(trace).pass;
void fired;

// @ts-expect-error -- the old predicate form is not a call this name accepts
hook(trace, "PreToolUse");

// @ts-expect-error -- a check is not a boolean, so it cannot stand in for one
const truthy: boolean = hook("PreToolUse");
void truthy;
