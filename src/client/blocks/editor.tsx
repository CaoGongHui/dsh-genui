import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import type { GenuiEditor } from '../spec.ts'
import { GENUI_LIMITS } from '../genui-runtime/index.ts'
import { useT } from '../i18n/index.ts'
import { writeClipboard } from '../primitive-adapter.ts'
import type { AnswersState } from './state.ts'
import css from './editor.module.css'

/** 纯文本编辑器，草稿保存在所属 GenUI 区块中。 */
export function EditorNode({ node, answers }: { node: GenuiEditor; answers?: AnswersState | undefined }): ReactElement {
  const t = useT()
  const id = useId()
  const [localValue, setLocalValue] = useState(node.value)
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(true)
  const touched = useRef(false)
  const initialDraft = useRef(answers?.fields[node.id])
  const registeredDefault = useRef<string | undefined>(undefined)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const draft = answers?.fields[node.id]
  const value = initialDraft.current === undefined ? localValue : draft ?? localValue

  useEffect(() => {
    if (initialDraft.current !== undefined || touched.current) return
    setLocalValue(node.value)
    if (node.value.trim() !== '') {
      registeredDefault.current = node.value
      answers?.setField(node.id, node.value)
    } else if (registeredDefault.current !== undefined) {
      registeredDefault.current = undefined
      answers?.setField(node.id, '')
    }
  }, [answers?.setField, node.id, node.value])

  useEffect(() => () => clearTimeout(saveTimer.current), [])

  /** 更新当前文字，并通知区块状态保存草稿。 */
  const updateValue = (next: string): void => {
    touched.current = true
    setLocalValue(next)
    answers?.setField(node.id, next)
    setSaved(false)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => setSaved(true), 350)
  }

  /** 将当前文字复制到剪贴板。 */
  const copyValue = (): void => {
    void writeClipboard(value).then((ok) => {
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }
    })
  }

  const labelId = `genui-editor-${id}`
  return (
    <section className={css.editor} data-genui-editor>
      <div className={css.toolbar}>
        <label className={css.label} htmlFor={labelId}>{node.label ?? t('block.editor')}</label>
        <span className={css.status} role="status">{saved ? t('block.editorSaved') : t('block.editorSaving')}</span>
        <button type="button" className={css.copy} onClick={copyValue}>
          {copied ? t('label.copiedShort') : t('label.copy')}
        </button>
      </div>
      <textarea
        id={labelId}
        className={css.textarea}
        value={value}
        placeholder={node.placeholder}
        rows={node.rows ?? 8}
        maxLength={GENUI_LIMITS.maxEditorChars}
        onChange={event => updateValue(event.currentTarget.value)}
        aria-describedby={`${labelId}-status`}
      />
      <span id={`${labelId}-status`} className={css.visuallyHidden}>{saved ? t('block.editorSaved') : t('block.editorSaving')}</span>
    </section>
  )
}
