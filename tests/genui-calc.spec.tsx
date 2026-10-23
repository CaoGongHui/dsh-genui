// @vitest-environment jsdom
// `calc`: local formula calculator. Pins the contract the SKILL promises —
// formulas recompute in the browser with no model round trip, strict SafeMath
// rejects typos and forward references before render, and an `id` makes the
// inputs durable and submittable — plus the SafeMath grammar it relies on.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GenuiBlock } from '../src/client/GenuiBlock.tsx'
import { GenuiActionContext } from '../src/client/action-context.ts'
import { loadBlockState } from '../src/client/interaction-store.ts'
import { isRenderableProcess, processGenuiSpec, repairGenuiSpec, validateGenuiSpec } from '../src/client/guard.ts'
import { checkMathExpr, compileMathExpr } from '../src/client/safe-math.ts'
import { evaluateCalc, formatCalcNumber, parseCalcNumber } from '../src/client/calc-engine.ts'
import type { GenuiCalc, GenuiSpec } from '../src/client/spec.ts'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const evalExpr = (expr: string, vars: Record<string, number> = {}): number => {
  const fn = compileMathExpr(expr, { vars, strict: true })
  if (fn === null) throw new Error(`did not compile: ${expr}`)
  return fn(0)
}

describe('SafeMath additions', () => {
  it('compares to 1/0 and branches with if()', () => {
    expect(evalExpr('3 >= 3')).toBe(1)
    expect(evalExpr('2 != 2')).toBe(0)
    expect(evalExpr('if(amount > 5000, amount * 0.2, amount * 0.1)', { amount: 6000 })).toBe(1200)
    expect(evalExpr('if(amount > 5000, amount * 0.2, amount * 0.1)', { amount: 100 })).toBe(10)
  })

  it('rounds to decimals without binary drift, and clamps', () => {
    expect(evalExpr('round(1.005, 2)')).toBe(1.01)
    expect(evalExpr('round(-1.005, 2)')).toBe(-1.01)
    expect(evalExpr('round(1234.5678, 1)')).toBe(1234.6)
    expect(evalExpr('round(2.5)')).toBe(3)
    expect(evalExpr('clamp(150, 0, 100)')).toBe(100)
  })

  it('never resolves a function name through the prototype chain', () => {
    expect(compileMathExpr('constructor(1)')).toBeNull()
    expect(compileMathExpr('toString(1)')).toBeNull()
    expect(compileMathExpr('valueOf()', { strict: true })).toBeNull()
  })

  it('strict mode refuses undeclared names and wrong arity; plot mode keeps its conveniences', () => {
    expect(checkMathExpr('a * x', { strict: true })).toMatch(/unknown identifier 'a'/)
    expect(checkMathExpr('x + 1', { vars: { x: 2 }, strict: true })).toBeNull()
    expect(checkMathExpr('pow(2)', { strict: true })).toMatch(/'pow' takes 2/)
    // Plot: implicit single-letter params default to 1, x samples, arity lenient.
    expect(compileMathExpr('a * x')?.(3)).toBe(3)
    expect(compileMathExpr('pow(2)')).not.toBeNull()
  })
})

describe('calc engine', () => {
  it('parses what people type into number fields', () => {
    expect(parseCalcNumber('１２３')).toBe(123)
    expect(parseCalcNumber('1,234.5')).toBe(1234.5)
    expect(parseCalcNumber(' -3 ')).toBe(-3)
    expect(parseCalcNumber('')).toBeNaN()
    expect(parseCalcNumber('12abc')).toBeNaN()
    expect(parseCalcNumber('0x10')).toBeNaN()
  })

  it('formats with fixed or capped decimals and never prints -0', () => {
    expect(formatCalcNumber(165, 2, 'en')).toBe('165.00')
    expect(formatCalcNumber(1234.5, undefined, 'en')).toBe('1,234.5')
    expect(formatCalcNumber(-0.001, 2, 'en')).toBe('0.00')
    expect(formatCalcNumber(Number.NaN, 2, 'en')).toBe('—')
  })

  it('chains named outputs in order and isolates a broken formula', () => {
    const node: Pick<GenuiCalc, 'inputs' | 'outputs'> = {
      inputs: [{ name: 'bill' }, { name: 'people' }],
      outputs: [
        { name: 'tip', label: 'tip', expr: 'bill * 0.1' },
        { name: 'total', label: 'total', expr: 'bill + tip' },
        { label: 'each', expr: 'total / people' },
        { label: 'broken', expr: 'total / nobody' },
      ],
    }
    const results = evaluateCalc(node, { bill: 400, people: 4 })
    expect(results.map(r => r.value).slice(0, 3)).toEqual([40, 440, 110])
    expect(results[3]!.value).toBeNaN()
    expect(results[3]!.error).toMatch(/unknown identifier 'nobody'/)
    // Division by zero is a non-finite result, not an error.
    expect(evaluateCalc(node, { bill: 400, people: 0 })[2]).toEqual({ value: Number.NaN })
  })
})

describe('calc guard', () => {
  const calc = (extra: Partial<GenuiCalc> & Record<string, unknown>) => ({ items: [{ type: 'calc', inputs: [{ name: 'bill', value: 100 }], outputs: [{ label: 'double', expr: 'bill * 2' }], ...extra }] })

  it('accepts a well-formed calculator', () => {
    expect(validateGenuiSpec(calc({})).errors).toEqual([])
    expect(isRenderableProcess(processGenuiSpec(calc({})))).toBe(true)
  })

  it('reports formula errors with their path, including forward references', () => {
    const typo = validateGenuiSpec(calc({ outputs: [{ label: 'x', expr: 'bil * 2' }] }))
    expect(typo.errors.join('\n')).toMatch(/items\[0\]\.outputs\[0\]\.expr: .*unknown identifier 'bil'/)
    const forward = validateGenuiSpec(calc({ outputs: [{ label: 'a', expr: 'later + 1' }, { name: 'later', label: 'b', expr: 'bill' }] }))
    expect(forward.errors.join('\n')).toMatch(/outputs\[0\]\.expr: .*unknown identifier 'later'/)
    expect(isRenderableProcess(processGenuiSpec(calc({ outputs: [{ label: 'x', expr: 'bil * 2' }] })))).toBe(false)
  })

  it('explains the spreadsheet percent slip', () => {
    const result = validateGenuiSpec(calc({ outputs: [{ label: 'tip', expr: 'bill * 10%' }] }))
    expect(result.errors.join('\n')).toMatch(/write percentages as \/100; % is modulo/)
  })

  it('rejects reserved, malformed, and duplicate names', () => {
    const errors = validateGenuiSpec(calc({
      inputs: [{ name: 'pi' }, { name: '2fast' }, { name: 'bill' }, { name: 'bill' }],
      outputs: [{ label: 'x', expr: 'bill' }],
    })).errors.join('\n')
    expect(errors).toMatch(/inputs\[0\]\.name: 'pi' is a reserved/)
    expect(errors).toMatch(/inputs\[1\]\.name: '2fast' must start with a letter/)
    expect(errors).toMatch(/inputs\[3\]\.name: 'bill' is already declared/)
  })

  it('rejects an over-long formula instead of truncating it', () => {
    const expr = Array.from({ length: 120 }, () => 'bill').join('+')
    expect(validateGenuiSpec(calc({ outputs: [{ label: 'x', expr }] })).errors.join('\n')).toMatch(/longer than 300/)
    expect(repairGenuiSpec(calc({ outputs: [{ label: 'x', expr }] }))?.items).toEqual([])
  })

  it('gives a slider both ends and clamps its value', () => {
    const spec = repairGenuiSpec(calc({ inputs: [{ name: 'rate', kind: 'slider', value: 250 }], outputs: [{ label: 'x', expr: 'rate' }] }))!
    const input = (spec.items[0] as GenuiCalc).inputs[0]!
    expect(input).toMatchObject({ name: 'rate', kind: 'slider', min: 0, max: 250, value: 250 })
  })

  it('adopts spreadsheet field names', () => {
    const processed = processGenuiSpec({ items: [{ type: 'calc', inputs: [{ id: 'bill', default: 5 }], outputs: [{ title: 'double', formula: 'bill * 2' }] }] })
    expect(isRenderableProcess(processed)).toBe(true)
    expect((processed.spec!.items[0] as GenuiCalc).outputs[0]).toMatchObject({ label: 'double', expr: 'bill * 2' })
    expect((processed.spec!.items[0] as GenuiCalc).inputs[0]).toMatchObject({ name: 'bill', value: 5 })
  })
})

const splitSpec = (id?: string): GenuiSpec => repairGenuiSpec({
  items: [{
    type: 'calc', title: '分账', ...(id === undefined ? {} : { id }),
    inputs: [
      { name: 'bill', label: '账单', value: 360, min: 0, prefix: '¥' },
      { name: 'tipRate', label: '小费比例', value: 10, min: 0, max: 30, kind: 'slider', unit: '%' },
      { name: 'people', label: '人数', value: 4, min: 1, max: 20, kind: 'slider' },
    ],
    outputs: [
      { name: 'tip', label: '小费', expr: 'bill * tipRate / 100', decimals: 2 },
      { name: 'total', label: '合计', expr: 'bill + tip', decimals: 2 },
      { label: '每人', expr: 'total / people', decimals: 2, prefix: '¥' },
    ],
  }],
})!

const headline = (container: HTMLElement): string =>
  container.querySelector('[data-genui-calc] [title="= total / people"]')?.textContent ?? ''

describe('CalcNode', () => {
  it('recomputes every result locally as inputs change', () => {
    const send = vi.fn()
    const { container } = render(
      <GenuiActionContext.Provider value={send}>
        <GenuiBlock spec={splitSpec()} />
      </GenuiActionContext.Provider>,
    )
    expect(headline(container)).toContain('99.00') // (360 + 36) / 4
    fireEvent.change(screen.getByLabelText('账单'), { target: { value: '600' } })
    expect(headline(container)).toContain('165.00') // (600 + 60) / 4
    fireEvent.change(screen.getByLabelText('人数'), { target: { value: '5' } })
    expect(headline(container)).toContain('132.00')
    // Zero model round trips: no action fires for recalculation.
    expect(send).not.toHaveBeenCalled()
  })

  it('marks unparseable input and shows a dash instead of a stale answer', () => {
    const { container } = render(<GenuiBlock spec={splitSpec()} />)
    const bill = screen.getByLabelText('账单')
    fireEvent.change(bill, { target: { value: 'abc' } })
    expect(bill.getAttribute('aria-invalid')).toBe('true')
    expect(headline(container)).toContain('—')
    expect(headline(container)).not.toContain('¥')
  })

  it('clamps an out-of-range number when the field loses focus', () => {
    render(<GenuiBlock spec={splitSpec()} />)
    const bill = screen.getByLabelText('账单') as HTMLInputElement
    fireEvent.change(bill, { target: { value: '-5' } })
    expect(bill.getAttribute('aria-invalid')).toBe('true')
    fireEvent.blur(bill)
    expect(bill.value).toBe('0')
    expect(bill.getAttribute('aria-invalid')).toBeNull()
  })

  it('with an id, restores inputs after refresh and submits them as id.name', async () => {
    const spec: GenuiSpec = { items: [...splitSpec('split').items, { type: 'submit', label: '发送', action: 'send' }] }
    const first = render(<GenuiBlock spec={spec} stateKey="calc-test" />)
    fireEvent.change(screen.getByLabelText('账单'), { target: { value: '800' } })
    // Durable saves are debounced (300 ms); a refresh after that restores them.
    await waitFor(() => expect(loadBlockState('calc-test')?.fields?.['split.bill']).toBe('800'))
    first.unmount()

    const send = vi.fn()
    const { container } = render(
      <GenuiActionContext.Provider value={send}>
        <GenuiBlock spec={spec} stateKey="calc-test" />
      </GenuiActionContext.Provider>,
    )
    expect((screen.getByLabelText('账单') as HTMLInputElement).value).toBe('800')
    expect(headline(container)).toContain('220.00') // (800 + 80) / 4
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(send).toHaveBeenCalled())
    expect(send.mock.calls[0]![1].fields).toMatchObject({ 'split.bill': '800', 'split.tipRate': '10', 'split.people': '4' })
  })

  it('without an id, stays out of submit payloads and durable state', async () => {
    const spec: GenuiSpec = { items: [...splitSpec().items, { type: 'input', id: 'note', label: '备注', value: 'hi' }, { type: 'submit', label: '发送', action: 'send' }] }
    const send = vi.fn()
    render(
      <GenuiActionContext.Provider value={send}>
        <GenuiBlock spec={spec} stateKey="calc-anon" />
      </GenuiActionContext.Provider>,
    )
    fireEvent.change(screen.getByLabelText('账单'), { target: { value: '800' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(send).toHaveBeenCalled())
    expect(Object.keys(send.mock.calls[0]![1].fields)).toEqual(['note'])
    await waitFor(() => expect(loadBlockState('calc-anon')?.fields).toEqual({ note: 'hi' }))
  })
})
