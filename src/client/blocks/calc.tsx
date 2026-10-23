/**
 * Calc: a local formula calculator. Inputs are typed numbers or sliders;
 * outputs are SafeMath strict-mode formulas recomputed on every change, with
 * no model round trip. With an `id`, input values persist across refresh and
 * join a sibling submit's `fields` as `${id}.${name}`.
 * @module @changfenhuang/dsh-genui/client/blocks/calc
 */
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import css from '../GenuiBlock.module.css'
import { renderInline } from '../inline.ts'
import { getLocale, useT } from '../i18n/index.ts'
import {
  clampCalcValue, defaultCalcStep, evaluateCalc, formatCalcNumber, initialCalcValue,
  isCalcValueInRange, parseCalcNumber,
} from '../calc-engine.ts'
import { calcFieldKey } from '../submission-registry.ts'
import type { GenuiCalc, GenuiCalcInput, GenuiCalcOutput } from '../spec.ts'
import type { AnswersState } from './state.ts'

/** Quiet period before the live region repeats the headline result. */
const ANNOUNCE_DELAY_MS = 600

/** Plain (ungrouped) text for an editable number, so it can be edited back. */
function editableText(value: number): string {
  return Number.isFinite(value) ? String(value) : ''
}

/** Value with its affixes, e.g. `¥` `1,234.50` ` /月`. */
function Figure({ output, value, locale }: { output: GenuiCalcOutput; value: number; locale: string }) {
  const finite = Number.isFinite(value)
  return (
    <>
      {finite && output.prefix !== undefined && <span className={css.calcAffix}>{output.prefix}</span>}
      <span className={css.calcNumber}>{formatCalcNumber(value, output.decimals, locale)}</span>
      {finite && output.unit !== undefined && <span className={css.calcAffix}>{output.unit}</span>}
    </>
  )
}

function CalcField({ input, text, onText, onCommit, fieldId, locale }: {
  input: GenuiCalcInput
  text: string
  onText: (text: string) => void
  onCommit: () => void
  fieldId: string
  locale: string
}) {
  const t = useT()
  const value = parseCalcNumber(text)
  const label = input.label ?? input.name
  const hintId = `${fieldId}-hint`
  if (input.kind === 'slider') {
    const min = input.min ?? 0
    const max = input.max ?? 100
    const shown = Number.isFinite(value) ? clampCalcValue(value, input) : min
    // Same spacing as result figures (`360 期`), except a symbol-like unit
    // such as `%` that reads as part of the number.
    const unit = input.unit === undefined ? '' : /^[%‰°]/.test(input.unit) ? input.unit : ` ${input.unit}`
    const readout = `${input.prefix ?? ''}${formatCalcNumber(shown, undefined, locale)}${unit}`
    return (
      <div className={css.calcField}>
        <div className={css.calcSliderHead}>
          <label className={css.calcFieldLabel} htmlFor={fieldId}>{renderInline(label, false)}</label>
          <span className={css.calcSliderValue} aria-hidden="true">{readout}</span>
        </div>
        <input
          id={fieldId}
          type="range"
          className={css.sliderInput}
          min={min}
          max={max}
          step={input.step ?? defaultCalcStep(input)}
          value={shown}
          aria-valuetext={readout}
          onChange={e => onText(e.currentTarget.value)}
        />
      </div>
    )
  }
  const invalid = text.trim() !== '' && !Number.isFinite(value)
  const outOfRange = Number.isFinite(value) && !isCalcValueInRange(value, input)
  const hint = invalid
    ? t('block.calcInvalid')
    : outOfRange
      ? t('block.calcRange', {
        min: input.min === undefined ? '−∞' : formatCalcNumber(input.min, undefined, locale),
        max: input.max === undefined ? '∞' : formatCalcNumber(input.max, undefined, locale),
      })
      : undefined
  return (
    <div className={css.calcField}>
      <label className={css.calcFieldLabel} htmlFor={fieldId}>{renderInline(label, false)}</label>
      <div className={css.calcControl} data-invalid={hint === undefined ? undefined : ''}>
        {input.prefix !== undefined && <span className={css.calcAffix} aria-hidden="true">{input.prefix}</span>}
        <input
          id={fieldId}
          className={css.calcInput}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={text}
          aria-invalid={hint === undefined ? undefined : true}
          aria-describedby={hint === undefined ? undefined : hintId}
          onChange={e => onText(e.currentTarget.value)}
          onBlur={onCommit}
          onKeyDown={e => { if (e.key === 'Enter') onCommit() }}
        />
        {input.unit !== undefined && <span className={css.calcAffix} aria-hidden="true">{input.unit}</span>}
      </div>
      {hint !== undefined && <span id={hintId} className={css.calcHint}>{hint}</span>}
    </div>
  )
}

export const CalcNode = memo(function CalcNode({ node, answers }: { node: GenuiCalc; answers?: AnswersState | undefined }) {
  const t = useT()
  const locale = getLocale()
  const uid = useId()
  const id = node.id
  const keyOf = (name: string): string | undefined => (id === undefined ? undefined : calcFieldKey(id, name))
  const [texts, setTexts] = useState<Record<string, string>>(() => Object.fromEntries(node.inputs.map(input => {
    const key = keyOf(input.name)
    const restored = key === undefined ? undefined : answers?.fields[key]
    return [input.name, restored ?? editableText(initialCalcValue(input))]
  })))

  // Register the starting values once, so a sibling submit collects them even
  // when the user never touches a field (mirrors the slider contract).
  const registered = useRef(false)
  useEffect(() => {
    if (registered.current || id === undefined) return
    registered.current = true
    for (const input of node.inputs) {
      const key = calcFieldKey(id, input.name)
      if (answers?.fields[key] === undefined) answers?.setField(key, texts[input.name] ?? '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setText = (name: string, text: string): void => {
    setTexts(prev => (prev[name] === text ? prev : { ...prev, [name]: text }))
    const key = keyOf(name)
    if (key !== undefined) answers?.setField(key, text)
  }
  // Clamp a typed value into range once the user is done with the field.
  const commit = (input: GenuiCalcInput): void => {
    const value = parseCalcNumber(texts[input.name] ?? '')
    if (!Number.isFinite(value)) return
    const clamped = clampCalcValue(value, input)
    if (clamped !== value) setText(input.name, editableText(clamped))
  }

  const values = useMemo(
    () => Object.fromEntries(node.inputs.map(input => [input.name, parseCalcNumber(texts[input.name] ?? '')])),
    [node.inputs, texts],
  )
  const results = useMemo(() => evaluateCalc(node, values), [node, values])

  // Headline outputs: those flagged `primary`, else the last one (the answer
  // usually comes last: tip → total → per person).
  const flagged = node.outputs.some(output => output.primary === true)
  const isPrimary = (index: number): boolean => (flagged ? node.outputs[index]!.primary === true : index === node.outputs.length - 1)

  // Screen readers hear the headline once the user pauses, not every slider tick.
  const announcement = node.outputs
    .map((output, i) => (isPrimary(i) ? `${output.label} ${output.prefix ?? ''}${formatCalcNumber(results[i]!.value, output.decimals, locale)}${output.unit ?? ''}` : null))
    .filter((line): line is string => line !== null)
    .join('；')
  const [spoken, setSpoken] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setSpoken(announcement), ANNOUNCE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [announcement])

  const titleId = `${uid}-title`
  const rows = node.outputs.map((output, i) => ({ output, result: results[i]!, index: i }))
  return (
    <div className={css.calc} role="group" aria-labelledby={node.title === undefined ? undefined : titleId} data-genui-calc>
      {node.title !== undefined && <div id={titleId} className={css.calcTitle}>{renderInline(node.title)}</div>}
      <div className={css.calcInputs}>
        {node.inputs.map((input, i) => (
          <CalcField
            key={input.name}
            input={input}
            text={texts[input.name] ?? ''}
            onText={text => setText(input.name, text)}
            onCommit={() => commit(input)}
            fieldId={`${uid}-in-${i}`}
            locale={locale}
          />
        ))}
      </div>
      <div className={css.calcResults} role="group" aria-label={t('block.calcResults')}>
        <div className={css.calcHeadlines}>
          {rows.filter(row => isPrimary(row.index)).map(({ output, result, index }) => (
            <div key={index} className={css.calcHeadline} title={`= ${output.expr}`}>
              <span className={css.calcHeadlineLabel}>{renderInline(output.label, false)}</span>
              <span className={css.calcHeadlineValue}><Figure output={output} value={result.value} locale={locale} /></span>
              {result.error !== undefined && <span className={css.calcHint} title={result.error}>{t('block.calcFormulaError')}</span>}
            </div>
          ))}
        </div>
        {rows.some(row => !isPrimary(row.index)) && (
          <dl className={css.calcRows}>
            {rows.filter(row => !isPrimary(row.index)).map(({ output, result, index }) => (
              <div key={index} className={css.calcRow} title={`= ${output.expr}`}>
                <dt className={css.calcRowLabel}>{renderInline(output.label, false)}</dt>
                <dd className={css.calcRowValue}>
                  <Figure output={output} value={result.value} locale={locale} />
                  {result.error !== undefined && <span className={css.calcHint} title={result.error}>{t('block.calcFormulaError')}</span>}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {node.caption !== undefined && <div className={css.calcCaption}>{renderInline(node.caption)}</div>}
      <span className={css.visuallyHidden} aria-live="polite">{spoken}</span>
    </div>
  )
})
