/**
 * Diagram render engine — the HEAVY half. This module imports Pele and is
 * bundled ONLY into the lazy asset bundle `lib/assets/pele.js`, loaded on
 * demand by the mermaid-lazy loader when a spec contains a `mermaid` node;
 * the main client bundle stays small.
 *
 * Pele (obsidianmd/pele, MIT) parses Mermaid 12.1 syntax itself and returns
 * an SVG string synchronously — no DOM container, no async layout pass, no
 * runtime dependencies. Its output carries class names and reads colours from
 * `--pele-*` CSS variables, so theming happens in CSS (see the `.mermaid`
 * block in GenuiBlock.module.css) and a host theme switch recolours an
 * already-rendered diagram. `renderMermaid` still returns a promise so the
 * lazy render queue and its abort/ordering guarantees are unchanged.
 *
 * Whitelist: only a fixed set of diagram kinds render; anything else throws
 * so the caller shows its fallback — except undeclared flowchart bodies
 * (model-generated sources missing the `graph TD` header line), which get
 * the declaration prepended via ensureFlowchartKind and render normally.
 * Pele escapes labels and filters link/image schemes; we still re-check the
 * rendered SVG before injecting it (see `assertSafeSvg` in mermaid-safe): the
 * injection point is the only place in GenUI that uses
 * `dangerouslySetInnerHTML`, so the last line of defense lives here, not in
 * the engine.
 * @module @changfenhuang/dsh-genui/client/pele-core
 */
import {
  detectType,
  register,
  render as renderDiagram,
  type DiagramType,
  type RenderOptions,
} from 'pele/core'
import flowchart from 'pele/diagrams/flowchart'
import sequence from 'pele/diagrams/sequence'
import classDiagram from 'pele/diagrams/class'
import state from 'pele/diagrams/state'
import gantt from 'pele/diagrams/gantt'
import pie from 'pele/diagrams/pie'
import er from 'pele/diagrams/er'
import journey from 'pele/diagrams/journey'
import gitGraph from 'pele/diagrams/gitGraph'
import { assertSafeSvg, ensureFlowchartKind, repairMermaidSource } from './mermaid-safe.ts'

// Register only the kinds the whitelist admits: `pele/core` ships the API
// without diagram types, so the asset bundle stays free of the other two
// dozen parsers and their renderers.
register(flowchart, sequence, classDiagram, state, gantt, pie, er, journey, gitGraph)

/** Diagram kinds allowed through to the renderer. */
const ALLOWED_TYPES: ReadonlySet<DiagramType> = new Set<DiagramType>([
  'flowchart', 'sequence', 'class', 'state', 'gantt', 'pie', 'er', 'journey', 'gitGraph',
])

/** Monotonic render id (replaces Math.random): no collisions, no entropy.
 * Pele prefixes every SVG id with it, so two diagrams on one page never share
 * title/description/clip ids. */
let renderSeq = 0

/** Base font size in pixels. Matches the 13px body scale the previous engine
 * was initialised with, so diagrams keep their density in the card. */
const FONT_SIZE = 13

function draw(source: string, target?: HTMLElement): string {
  const host = target ?? (typeof document === 'undefined' ? undefined : document.body)
  // Measure with the SAME font the diagram will be displayed in: Pele sizes
  // nodes from label widths, and an inherited host font is only known here.
  const family = host === undefined || host === null ? '' : getComputedStyle(host).fontFamily
  const width = target?.clientWidth ?? 0
  const options: RenderOptions = {
    fontSize: FONT_SIZE,
    idPrefix: `genui-pele-${renderSeq++}`,
    ...(family === '' ? {} : { fontFamily: family }),
    // Let the layout adapt to the card instead of shrinking a wide diagram
    // into illegibility; `responsive` still caps the width when it cannot.
    ...(width > 0 ? { maxWidth: width } : {}),
  }
  const result = renderDiagram(source, options)
  assertSafeSvg(result.svg)
  return result.svg
}

/**
 * Render mermaid source to an SVG string.
 * @param code - the mermaid diagram source.
 * @param target - final diagram element whose inherited font and width drive layout.
 * @returns the rendered SVG markup (verified free of script/event handlers).
 * @throws when the kind is not whitelisted, rendering fails, or the output
 *   fails the sanitization check.
 */
export async function renderMermaid(code: string, target?: HTMLElement): Promise<string> {
  let source = code.trim()
  const declared = /^([A-Za-z]+)/.exec(source)?.[1] ?? ''
  let type = detectType(source)
  if (type === null || !ALLOWED_TYPES.has(type)) {
    // Lenient: model-generated sources frequently omit the mandatory
    // diagram-type declaration line (`A --> B` with no leading
    // `graph TD`). Detect a flowchart body by its edge arrows and prepend
    // the declaration instead of throwing straight to the raw-source
    // fallback; genuinely unclassifiable input still fails as before.
    const lenient = ensureFlowchartKind(source)
    if (lenient !== source) {
      source = lenient
      type = detectType(source)
    }
  }
  if (type === null || !ALLOWED_TYPES.has(type)) {
    throw new Error(`mermaid kind '${declared}' is not allowed`)
  }
  try {
    return draw(source, target)
  } catch (error) {
    // Retry once with the label-repair pass; a repaired source rendering
    // successfully beats a syntax-error fallback for the same content.
    const repaired = repairMermaidSource(source)
    if (repaired !== source) return draw(repaired, target)
    throw error
  }
}