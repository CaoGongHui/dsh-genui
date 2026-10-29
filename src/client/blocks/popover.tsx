import { useState, type ReactElement } from 'react'
import {
  FloatingFocusManager,
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  safePolygon,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useRole,
} from '@floating-ui/react'
import type { GenuiPopover } from '../spec.ts'
import { renderInline } from '../inline.ts'
import { useT } from '../i18n/index.ts'
import css from './popover.module.css'

/** 显示支持点击、悬停、键盘操作和关闭行为的浮层说明。 */
export function PopoverNode({ node }: { node: GenuiPopover }): ReactElement {
  const t = useT()
  const [open, setOpen] = useState(false)
  const trigger = node.trigger ?? 'click'
  const { refs, context, floatingStyles } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: node.placement ?? 'top',
    middleware: [offset(8), flip({ padding: 12 }), shift({ padding: 12 })],
    whileElementsMounted: autoUpdate,
  })
  const click = useClick(context, { enabled: trigger === 'click' })
  const hover = useHover(context, { enabled: trigger === 'hover', handleClose: safePolygon() })
  const focus = useFocus(context)
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'dialog' })
  const { getReferenceProps, getFloatingProps } = useInteractions([click, hover, focus, dismiss, role])

  return (
    <span className={css.root} data-genui-popover>
      <button ref={refs.setReference} className={css.trigger} type="button" {...getReferenceProps({ 'aria-label': node.label })}>
        {renderInline(node.label, false)}
      </button>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} returnFocus>
            <div ref={refs.setFloating} className={css.panel} style={floatingStyles} {...getFloatingProps()}>
              <div className={css.content}>{renderInline(node.content)}</div>
              <button className={css.close} type="button" aria-label={t('block.popoverClose')} onClick={() => setOpen(false)}>×</button>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </span>
  )
}
