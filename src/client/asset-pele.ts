/**
 * Pele asset-bundle entry: registers the diagram engine on
 * `window.__GenuiAssets__.pele`. Built as a standalone IIFE into
 * `lib/assets/pele.js` and served by the plugin's node-half route; loaded
 * on demand by mermaid-lazy.
 * @module @changfenhuang/dsh-genui/client/asset-pele
 */
import { renderMermaid } from './pele-core.ts'
import { assertSafeSvg, repairMermaidSource } from './mermaid-safe.ts'

const win = globalThis as unknown as { __GenuiAssets__?: Record<string, unknown> }
const assets = win.__GenuiAssets__ ?? (win.__GenuiAssets__ = {})
assets.pele = { assertSafeSvg, repairMermaidSource, renderMermaid }