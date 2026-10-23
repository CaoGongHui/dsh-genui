// @vitest-environment jsdom
// Real-renderer coverage for the Pele engine: the component tests mock the
// lazy loader, so this is the only place the actual Mermaid-source → SVG path
// (kind gate, lenient flowchart header, label repair, sanitization gate) runs.
import { beforeAll, describe, expect, it } from 'vitest'
import { renderMermaid } from '../src/client/pele-core.ts'

beforeAll(() => {
  // jsdom has no canvas: Pele probes for a 2D context, jsdom answers with a
  // "Not implemented" console error, and Pele falls back to its built-in width
  // table. Stub the probe so the fallback is silent and deterministic.
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext
})

describe('Pele renderer', () => {
  it('renders a whitelisted flowchart to an SVG that themes through CSS variables', async () => {
    const svg = await renderMermaid('graph TD\n  A[开始] --> B[结束]')
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('class="pele')
    // Colours come from the host variables bridged in GenuiBlock.module.css,
    // not from inline hex values baked in at render time.
    expect(svg).toContain('var(--pele-surface')
    expect(svg).toContain('var(--pele-fg')
  })

  it('prefixes SVG ids per render so two diagrams never collide', async () => {
    const source = 'flowchart TD\n  accTitle: 标题\n  accDescr: 说明\n  A --> B'
    const first = await renderMermaid(source)
    const second = await renderMermaid(source)
    const ids = (svg: string): string[] => [...svg.matchAll(/(?:^|[\s"'])id="([^"]+)"/g)].map(match => match[1] ?? '')
    const left = ids(first)
    const right = ids(second)
    expect(left.length).toBeGreaterThan(0)
    expect(left.some(id => right.includes(id))).toBe(false)
  })

  it('accepts a flowchart body that omits the declaration line', async () => {
    const svg = await renderMermaid('A[输入] --> B[输出]')
    expect(svg).toContain('pele-flowchart')
  })

  it('rejects a diagram kind outside the whitelist', async () => {
    await expect(renderMermaid('mindmap\n  root((Pele))')).rejects.toThrow(/not allowed/)
  })

  it('rejects unrecognized text instead of drawing an error diagram', async () => {
    await expect(renderMermaid('Hello, world')).rejects.toThrow()
  })

  it('repairs a label that the parser rejects, then renders', async () => {
    // A pipe edge label carrying brackets is node grammar to the parser; the
    // repair pass quotes it (`|"…"|`, display-neutral) and the retry succeeds.
    const svg = await renderMermaid('flowchart LR\n  A -->|6. 用户交互 → [genui-action]| B')
    expect(svg).toContain('pele-flowchart')
    expect(svg).toContain('genui-action')
  })

  it('keeps the SVG free of script and event-handler injection', async () => {
    const svg = await renderMermaid('flowchart LR\n  A["<img src=x onerror=alert(1)>"] --> B')
    expect(svg).not.toMatch(/<script|onerror\s*=|javascript:/i)
  })
})