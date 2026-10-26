/**
 * SafeMath 为 GenUI plot 和 Computed 提供受限数学表达式解析。
 *
 * 表达式使用白名单函数与常量，不调用 eval 或 new Function。strict 模式拒绝未声明名称，但允许内置常量；plot 模式允许单字母隐式参数。对象属性访问和未允许的函数调用始终会被拒绝。
 *
 * 支持的语法：
 *   compare := expr (('<' | '<=' | '>' | '>=' | '==' | '!=') expr)?   → 1 或 0
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/' | '%') unary)*
 *   unary   := ('-' | '+') unary | power
 *   power   := atom ('^' atom)?
 *   atom    := number | variable | constant | func '(' compare (',' compare)* ')' | '(' compare ')'
 *   constant: 'pi' | 'e' | 'tau'
 *   func    : sin cos tan asin acos atan sqrt cbrt exp log ln abs floor ceil
 *             round(v[, digits]) min max pow if(cond, then, else) clamp(v, lo, hi)
 */

export interface SafeMathOptions {
  /** 字段值；strict 模式还允许使用未被字段覆盖的内置常量。 */
  vars?: Record<string, number>
  /** 关闭 plot 使用的单字母隐式参数。 */
  allowImplicitVariables?: boolean
  /** 校验函数参数个数（calc 使用）；plot 与 Computed 保持历史上的宽松行为。 */
  checkArity?: boolean
}

export interface SafeMathProgram {
  /** 计算编译后的表达式；plot 模式使用传入的 x 作为采样值。 */
  evaluate: (x: number) => number
  /** 表达式引用的已声明字段名称；strict 模式下同名字段可以覆盖内置常量。 */
  variables: string[]
}

export const SAFE_MATH_LIMITS = {
  maxExpressionLength: 512,
  maxDepth: 32,
} as const

/** 解析十进制输入，拒绝 JavaScript Number 接受的非十进制进制写法。 */
export function parseDecimalNumber(value: string): number | undefined {
  const normalized = value.trim()
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) return undefined
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : undefined
}

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
}

/** 按数字自身的十进制字符串移动小数点，1.005 移两位正好是 100.5（`1.005 * 100` 是 100.49999…）。 */
function shiftDecimal(value: number, by: number): number {
  const [mantissa, exponent = '0'] = String(value).split('e')
  return Number(`${mantissa}e${Number(exponent) + by}`)
}

/** `round(v, digits)` 在 0–10 位小数上远离零舍入；`round(v)` 仍是 Math.round。 */
function roundTo(value: number, digits?: number): number {
  if (digits === undefined) return Math.round(value)
  if (!Number.isFinite(value) || !Number.isFinite(digits)) return Number.NaN
  const d = Math.max(0, Math.min(10, Math.trunc(digits)))
  return Math.sign(value) * shiftDecimal(Math.round(shiftDecimal(Math.abs(value), d)), -d)
}

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sqrt: Math.sqrt, cbrt: Math.cbrt,
  exp: Math.exp, log: Math.log10, ln: Math.log,
  abs: Math.abs, floor: Math.floor, ceil: Math.ceil,
  round: (v, d) => roundTo(v, d),
  min: Math.min, max: Math.max,
  pow: (a, b) => Math.pow(a, b),
  // 条件为 NaN 表示输入未知：向下传递 NaN，而不是挑一个分支。
  if: (c, a, b) => (Number.isNaN(c) ? Number.NaN : c !== 0 ? a : b),
  clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
}

/** 各函数的 [最少, 最多] 参数个数，仅在 `checkArity` 时校验。 */
const ARITY: Record<string, readonly [number, number]> = {
  sin: [1, 1], cos: [1, 1], tan: [1, 1], asin: [1, 1], acos: [1, 1], atan: [1, 1],
  sqrt: [1, 1], cbrt: [1, 1], exp: [1, 1], log: [1, 1], ln: [1, 1],
  abs: [1, 1], floor: [1, 1], ceil: [1, 1], round: [1, 2],
  min: [1, 64], max: [1, 64], pow: [2, 2], if: [3, 3], clamp: [3, 3],
}

/** 变量不能使用的名称：它们会解析为常量或函数。 */
export const SAFE_MATH_RESERVED: ReadonlySet<string> = new Set([...Object.keys(CONSTANTS), ...Object.keys(FUNCTIONS)])

const COMPARATORS: Record<string, (a: number, b: number) => boolean> = {
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
}

class ParseError extends Error {
  constructor(message: string, readonly pos: number) {
    super(`SafeMath parse error at ${pos}: ${message}`)
  }
}

class SafeMathParser {
  private i = 0
  private depth = 0
  private readonly variables = new Set<string>()
  constructor(
    private readonly src: string,
    private readonly vars: Record<string, number>,
    private readonly allowImplicitVariables: boolean,
    private readonly checkArity = false,
  ) {}

  parse(): SafeMathProgram {
    const node = this.parseCompare()
    this.skipWs()
    if (this.i < this.src.length) throw new ParseError('unexpected trailing input', this.i)
    return { evaluate: this.evalNode(node), variables: [...this.variables] }
  }

  /** 最低优先级：至多一次比较，结果为 1（真）或 0。 */
  private parseCompare(): number | ((x: number) => number) {
    const left = this.parseExpr()
    this.skipWs()
    const two = this.src.slice(this.i, this.i + 2)
    const one = this.peek()
    const op = Object.hasOwn(COMPARATORS, two) ? two : one === '<' || one === '>' ? one : undefined
    if (op === undefined) return left
    this.i += op.length
    const right = this.parseExpr()
    const compare = COMPARATORS[op]!
    return (x) => (compare(this.asNum(left, x), this.asNum(right, x)) ? 1 : 0)
  }

  private evalNode(node: number | ((x: number) => number)): (x: number) => number {
    if (typeof node === 'number') return () => node
    return node
  }

  private parseExpr(): number | ((x: number) => number) {
    let left = this.parseTerm()
    for (;;) {
      this.skipWs()
      const c = this.peek()
      if (c === '+' || c === '-') {
        this.i++
        const right = this.parseTerm()
        const op = c
        const prev = left
        left = op === '+'
          ? (x) => this.asNum(prev, x) + this.asNum(right, x)
          : (x) => this.asNum(prev, x) - this.asNum(right, x)
      } else return left
    }
  }

  private parseTerm(): number | ((x: number) => number) {
    let left = this.parseUnary()
    for (;;) {
      this.skipWs()
      const c = this.peek()
      if (c === '*' || c === '/' || c === '%') {
        this.i++
        const right = this.parseUnary()
        const op = c
        const prev = left
        left = op === '*'
          ? (x) => this.asNum(prev, x) * this.asNum(right, x)
          : op === '/'
            ? (x) => this.asNum(prev, x) / this.asNum(right, x)
            : (x) => this.asNum(prev, x) % this.asNum(right, x)
      } else return left
    }
  }

  private parseUnary(): number | ((x: number) => number) {
    this.skipWs()
    const c = this.char()
    if (c === '-' || c === '+') {
      this.i++
      const operand = this.withDepth(() => this.parseUnary())
      return c === '-' ? (x) => -this.asNum(operand, x) : (x) => this.asNum(operand, x)
    }
    return this.parsePower()
  }

  private parsePower(): number | ((x: number) => number) {
    const base = this.parseAtom()
    this.skipWs()
    if (this.peek() === '^') {
      this.i++
      const exp = this.withDepth(() => this.parsePower())
      const prev = base
      return (x) => Math.pow(this.asNum(prev, x), this.asNum(exp, x))
    }
    return base
  }

  private parseAtom(): number | ((x: number) => number) {
    this.skipWs()
    const c = this.char()
    if (c === '(') {
      this.i++
      const inner = this.withDepth(() => this.parseCompare())
      this.skipWs()
      if (this.peek() !== ')') throw new ParseError('expected )', this.i)
      this.i++
      return inner
    }
    if (c >= '0' && c <= '9' || c === '.') return this.parseNumber()
    if (this.isIdentStart(c)) return this.parseIdent()
    throw new ParseError(`unexpected character '${c}'`, this.i)
  }

  private parseNumber(): number {
    const start = this.i
    let sawDigit = false

    while (this.i < this.src.length && /[0-9]/.test(this.src[this.i]!)) {
      sawDigit = true
      this.i++
    }

    if (this.peek() === '.') {
      this.i++
      while (this.i < this.src.length && /[0-9]/.test(this.src[this.i]!)) {
        sawDigit = true
        this.i++
      }
    }

    if (!sawDigit) {
      throw new ParseError(`invalid number '${this.src.slice(start, this.i)}'`, start)
    }

    if (this.peek() === 'e' || this.peek() === 'E') {
      this.i++
      if (this.peek() === '+' || this.peek() === '-') this.i++
      const exponentStart = this.i
      while (this.i < this.src.length && /[0-9]/.test(this.src[this.i]!)) this.i++
      if (this.i === exponentStart) {
        throw new ParseError(`invalid number '${this.src.slice(start, this.i)}'`, start)
      }
    }

    const text = this.src.slice(start, this.i)
    const value = Number(text)
    if (!Number.isFinite(value)) throw new ParseError(`invalid number '${text}'`, start)
    return value
  }

  private parseIdent(): number | ((x: number) => number) {
    const start = this.i
    while (this.i < this.src.length && this.isIdentChar(this.src[this.i]!)) this.i++
    const name = this.src.slice(start, this.i)
    this.skipWs()
    if (this.peek() === '(') {
      // 解析白名单函数调用。
      if (!Object.hasOwn(FUNCTIONS, name)) throw new ParseError(`unknown function '${name}'`, start)
      const fn = FUNCTIONS[name]!
      this.i++
      const args: Array<number | ((x: number) => number)> = []
      this.skipWs()
      if (this.peek() === ')') {
        this.i++
      } else {
        for (;;) {
          args.push(this.withDepth(() => this.parseCompare()))
          this.skipWs()
          const sep = this.peek()
          if (sep === ',') { this.i++; continue }
          if (sep === ')') { this.i++; break }
          throw new ParseError('expected , or ) in call', this.i)
        }
      }
      if (this.checkArity) {
        const [least, most] = ARITY[name] ?? [0, 64]
        if (args.length < least || args.length > most) {
          const want = least === most ? `${least}` : `${least}–${most}`
          throw new ParseError(`'${name}' takes ${want} argument(s), got ${args.length}`, start)
        }
      }
      return (x) => fn(...args.map(a => this.asNum(a, x)))
    }
    // 使用自有属性检查，避免 `constructor` 和 `toString` 等原型名称被当作字段。
    if (!this.allowImplicitVariables && Object.hasOwn(this.vars, name)) {
      this.variables.add(name)
      const captured = this.vars[name]!
      return () => captured
    }
    if (Object.hasOwn(CONSTANTS, name) && this.allowImplicitVariables) return CONSTANTS[name]!
    if (this.allowImplicitVariables && name === 'x') {
      // plot 的采样变量从计算参数读取。
      return (value: number) => value
    }
    if (Object.hasOwn(this.vars, name)) {
      this.variables.add(name)
      // 声明参数使用编译时的值；更新参数时会以新值重新编译。
      const captured = this.vars[name]!
      return () => captured
    }
    // plot 中未声明的单个小写字母参数默认取 1；该规则不接受全局对象名称。
    if (Object.hasOwn(CONSTANTS, name)) return CONSTANTS[name]!
    if (this.allowImplicitVariables && /^[a-z]$/.test(name)) return () => 1
    throw new ParseError(`unknown identifier '${name}'`, start)
  }

  private asNum(node: number | ((x: number) => number), x: number): number {
    return typeof node === 'number' ? node : node(x)
  }

  /** 在递归解析前限制表达式层数。 */
  private withDepth<T>(read: () => T): T {
    this.depth += 1
    if (this.depth > SAFE_MATH_LIMITS.maxDepth) {
      this.depth -= 1
      throw new ParseError('expression nesting exceeds limit', this.i)
    }
    try {
      return read()
    } finally {
      this.depth -= 1
    }
  }

  private skipWs(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i]!)) this.i++
  }

  private peek(): string | undefined {
    return this.src[this.i]
  }

  private char(): string {
    const c = this.peek()
    if (c === undefined) throw new ParseError('unexpected end of input', this.i)
    return c
  }

  private isIdentStart(c: string | undefined): boolean {
    return c !== undefined && /[a-zA-Z_]/.test(c)
  }

  private isIdentChar(c: string): boolean {
    return /[a-zA-Z0-9_]/.test(c)
  }
}

/**
 * 编译表达式以便后续计算。
 * @param expr - 数学表达式；默认模式将 `x` 作为采样变量，strict 模式按已声明字段解析。
 * @param options - 字段值和变量解析规则。
 * @returns 可执行的计算函数；表达式无效时返回 null。
 */
export function compileMathExpr(expr: string, options: SafeMathOptions = {}): ((x: number) => number) | null {
  return compileMathExprProgram(expr, options)?.evaluate ?? null
}

/**
 * 编译安全数学表达式，并返回表达式引用的字段名称。
 *
 * @param expr - 受限算术表达式。
 * @param options - 字段值和变量解析规则。
 * @returns 编译后的程序；表达式无效时返回 null。
 */
export function compileMathExprProgram(expr: string, options: SafeMathOptions = {}): SafeMathProgram | null {
  try {
    return buildProgram(expr, options)
  } catch {
    return null
  }
}

/** 编译并在失败时抛出带位置的错误；compileMathExprProgram 与 checkMathExpr 共用。 */
function buildProgram(expr: string, options: SafeMathOptions): SafeMathProgram {
  // plot 模式保留 `x` 采样变量；strict 模式允许字段使用该名称。
  const vars: Record<string, number> = { ...options.vars }
  if (options.allowImplicitVariables !== false) delete vars.x
  if (expr.length > SAFE_MATH_LIMITS.maxExpressionLength) {
    throw new ParseError(`expression longer than ${SAFE_MATH_LIMITS.maxExpressionLength} characters`, 0)
  }
  const nonFinite = Object.keys(vars).find(name => !Number.isFinite(vars[name]))
  if (nonFinite !== undefined) throw new ParseError(`variable '${nonFinite}' is not a finite number`, 0)
  return new SafeMathParser(expr, vars, options.allowImplicitVariables !== false, options.checkArity === true).parse()
}

/**
 * 说明表达式为何无法编译。
 * @returns 带字符位置的解析错误；表达式在 `options` 下有效时返回 null。
 */
export function checkMathExpr(expr: string, options: SafeMathOptions = {}): string | null {
  try {
    buildProgram(expr, options)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : 'SafeMath parse error'
  }
}

/**
 * 在指定范围内采样表达式。
 * @param expr - 使用 x 和可选参数的数学表达式。
 * @param xMin - 采样起点。
 * @param xMax - 采样终点。
 * @param samples - 采样点数量，至少为 2。
 * @param params - 参数值；参数变化时会重新编译表达式。
 * @returns 有限的 [x, y] 坐标对。
 */
export function sampleExpr(
  expr: string,
  xMin: number,
  xMax: number,
  samples = 200,
  params: Record<string, number> = {},
): Array<[number, number]> {
  const fn = compileMathExpr(expr, { vars: params })
  if (fn === null) return []
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || xMax <= xMin || samples < 2) return []
  const points: Array<[number, number]> = []
  const step = (xMax - xMin) / (samples - 1)
  for (let i = 0; i < samples; i++) {
    const x = xMin + step * i
    const y = fn(x)
    if (Number.isFinite(y)) points.push([x, y])
  }
  return points
}
