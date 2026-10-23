/**
 * Pure evaluation core for the `calc` component: name rules, number parsing,
 * strict-mode formula evaluation, and result formatting. No React, no DOM —
 * shared by the renderer, the guard's validation pass, and tests.
 *
 * Formulas are SafeMath expressions compiled in strict mode: every identifier
 * must be a declared input, an earlier named output, a constant, or a
 * white-listed function call. Nothing reaches `eval`, globals, or prototypes.
 * @module @changfenhuang/dsh-genui/client/calc-engine
 */
import { checkMathExpr, compileMathExpr, SAFE_MATH_RESERVED } from './safe-math.ts'
import type { GenuiCalc, GenuiCalcInput } from './spec.ts'

/** Variable names formulas may declare: identifier-shaped, ≤32 characters. */
export const CALC_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/

/** Why `name` cannot be a calc variable, or null when it can. */
export function calcNameProblem(name: string): string | null {
  if (!CALC_NAME_RE.test(name)) return `'${name}' must start with a letter or _ and use only letters, digits, _ (max 32)`
  if (SAFE_MATH_RESERVED.has(name)) return `'${name}' is a reserved math function or constant`
  return null
}

/** A percent written the spreadsheet way (`10%`) parses as modulo in SafeMath. */
const PERCENT_SUFFIX_RE = /\d\s*%\s*(?:$|[)+\-*/,<>=!])/

/**
 * Explain why an output formula cannot run against `scope`, or null when it
 * compiles. Adds a percent hint because `x * 10%` is the most common slip.
 */
export function calcFormulaProblem(expr: string, scope: Readonly<Record<string, number>>): string | null {
  const problem = checkMathExpr(expr, { vars: { ...scope }, strict: true })
  if (problem === null) return null
  return PERCENT_SUFFIX_RE.test(expr) ? `${problem} (write percentages as /100; % is modulo)` : problem
}

/** One computed output: the value, plus the compile error when it has none. */
export interface CalcResult {
  value: number
  error?: string
}

/**
 * Evaluate every output in order. Earlier named outputs join the scope, so a
 * later formula can reuse them; a forward reference is a compile error.
 * A non-finite result (bad input, division by zero) is NaN, shown as "—".
 */
export function evaluateCalc(node: Pick<GenuiCalc, 'inputs' | 'outputs'>, values: Readonly<Record<string, number>>): CalcResult[] {
  const scope: Record<string, number> = {}
  for (const input of node.inputs) scope[input.name] = values[input.name] ?? Number.NaN
  return node.outputs.map(output => {
    const fn = compileMathExpr(output.expr, { vars: scope, strict: true })
    if (fn === null) {
      const error = calcFormulaProblem(output.expr, scope) ?? 'invalid formula'
      // Later outputs may still reference this name; they read "unknown".
      if (output.name !== undefined) scope[output.name] = Number.NaN
      return { value: Number.NaN, error }
    }
    const raw = fn(0)
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : Number.NaN
    if (output.name !== undefined) scope[output.name] = value
    return { value }
  })
}

/** Starting value of an input: spec value, else min, else 0 — clamped. */
export function initialCalcValue(input: GenuiCalcInput): number {
  const raw = input.value ?? input.min ?? 0
  return clampCalcValue(raw, input)
}

/** Clamp into the input's declared [min, max] (either bound optional). */
export function clampCalcValue(value: number, input: Pick<GenuiCalcInput, 'min' | 'max'>): number {
  let out = value
  if (input.min !== undefined) out = Math.max(input.min, out)
  if (input.max !== undefined) out = Math.min(input.max, out)
  return out
}

const NUMBER_TEXT_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i

/**
 * Parse what a person typed into a number field: full-width digits and signs
 * (Chinese IMEs), thousands separators, and surrounding spaces are accepted;
 * anything else (including empty text) is NaN.
 */
export function parseCalcNumber(text: string): number {
  const normalized = text
    .replace(/[\uFF10-\uFF19]/g, digit => String.fromCharCode(digit.charCodeAt(0) - 0xFEE0))
    .replace(/[．。]/g, '.')
    .replace(/[－−]/g, '-')
    .replace(/＋/g, '+')
    .replace(/[,，_\s]/g, '')
  return NUMBER_TEXT_RE.test(normalized) ? Number(normalized) : Number.NaN
}

/** Is `value` inside the input's bounds? */
export function isCalcValueInRange(value: number, input: Pick<GenuiCalcInput, 'min' | 'max'>): boolean {
  return (input.min === undefined || value >= input.min) && (input.max === undefined || value <= input.max)
}

/**
 * Locale-format a result: fixed `decimals` when given, otherwise up to 2
 * places. Rounds before the sign check so a tiny negative never prints "-0".
 * Non-finite values print as an em dash.
 */
export function formatCalcNumber(value: number, decimals: number | undefined, locale: string): string {
  if (!Number.isFinite(value)) return '—'
  const places = decimals ?? 2
  const shown = Math.abs(value) < 0.5 / 10 ** places ? 0 : value
  const options: Intl.NumberFormatOptions = decimals === undefined
    ? { maximumFractionDigits: places }
    : { minimumFractionDigits: places, maximumFractionDigits: places }
  try {
    return new Intl.NumberFormat(locale, options).format(shown)
  } catch {
    return String(shown)
  }
}

/** Default slider step: 1 for wide ranges, else 1/100 of the span. */
export function defaultCalcStep(input: Pick<GenuiCalcInput, 'min' | 'max'>): number {
  const span = (input.max ?? 100) - (input.min ?? 0)
  if (!Number.isFinite(span) || span <= 0) return 1
  return span >= 10 ? 1 : Number((span / 100).toPrecision(2))
}
