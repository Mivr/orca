// @vitest-environment happy-dom
/**
 * iPadOS Hangul with a hardware keyboard fires no composition events at all
 * (#13345). Captured on the device, each jamo is a plain keydown whose `key` is
 * the jamo, followed by the IME rewriting the composing syllable in place:
 *
 *   keydown 'ㅎ' → insertText 'ㅎ'                       value 'ㅎ'
 *   keydown 'ㅏ' → deleteContentBackward, insertText '하' value '하'
 *   keydown 'ㄴ' → deleteContentBackward, insertText '한' value '한'
 *   keydown 'ㄱ' → insertText 'ㄱ'                       value '한ㄱ'
 *
 * Unpatched xterm sends the jamo from `_keyPress` and drops the composed
 * `insertText`, because `_inputEvent` admits a composed insert only when no key
 * is down — and one is down for every one of them. The PTY sees `ㅎㅏㄴㄱㅡㄹ`.
 *
 * These suites drive a real xterm `Terminal` through the same tracker, bypass
 * policy and preedit controller the pane lifecycle installs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  disposeOpenTerminals,
  dispatchComposition,
  dispatchInput,
  dispatchKey,
  nextEventLoop,
  openIosTerminal,
  pretendIosWeb,
  typeHangeul,
  typeJamo,
  typePrintable
} from './terminal-ios-hangul-preedit-fixture'

describe('iPadOS Hangul typed as bare keydowns', () => {
  let originalUserAgent: PropertyDescriptor | undefined
  let originalMaxTouchPoints: PropertyDescriptor | undefined

  beforeEach(() => {
    originalUserAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent')
    originalMaxTouchPoints = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints')
    // happy-dom has no 2d context, which the DOM renderer's WidthCache requires.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    disposeOpenTerminals()
    if (originalUserAgent) {
      Object.defineProperty(navigator, 'userAgent', originalUserAgent)
    }
    if (originalMaxTouchPoints) {
      Object.defineProperty(navigator, 'maxTouchPoints', originalMaxTouchPoints)
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('sends composed syllables, not the jamo the keydowns carry', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeHangeul(rig)
    dispatchKey(rig, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })

    expect(rig.emitted).toEqual(['한', '글', '\r'])
  })

  it('commits a syllable once, with no intermediate state to retract', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeHangeul(rig)

    // Only the syllable the IME finished has been sent; `글` is still held.
    expect(rig.emitted).toEqual(['한'])
    expect(rig.preedit.heldText()).toBe('글')
  })

  it('shows the open syllable in the preedit overlay as it grows', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })
    expect(rig.compositionView.classList.contains('active')).toBe(true)
    expect(rig.compositionView.textContent).toBe('ㅎ')

    await typeJamo(rig, 'ㅏ', '하', { replaces: true })
    expect(rig.compositionView.textContent).toBe('하')
    expect(rig.emitted).toEqual([])
  })

  it('hides the overlay once the syllable is committed', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })
    dispatchKey(rig, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })

    expect(rig.compositionView.classList.contains('active')).toBe(false)
    expect(rig.compositionView.textContent).toBe('')
    expect(rig.emitted).toEqual(['ㅎ', '\r'])
  })

  it('composes after text already sitting on the line', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    for (const [key, keyCode] of [
      ['e', 69],
      ['c', 67],
      ['h', 72],
      ['o', 79],
      [' ', 32]
    ] as const) {
      await typePrintable(rig, { key, keyCode, written: key, replaces: false })
    }
    await typeHangeul(rig)
    dispatchKey(rig, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })

    expect(rig.emitted.join('')).toBe('echo 한글\r')
  })

  it('leaves ASCII typing on the same device untouched', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typePrintable(rig, { key: 'l', keyCode: 76, written: 'l', replaces: false })
    await typePrintable(rig, { key: 's', keyCode: 83, written: 's', replaces: false })

    expect(rig.emitted).toEqual(['l', 's'])
    expect(rig.compositionView.classList.contains('active')).toBe(false)
  })

  it('commits the open syllable before the space that follows it', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeHangeul(rig)
    await typePrintable(rig, { key: ' ', keyCode: 32, written: ' ', replaces: false })

    expect(rig.emitted).toEqual(['한', '글', ' '])
  })

  it('commits the open syllable when the textarea loses focus', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeHangeul(rig)
    rig.textarea.dispatchEvent(new FocusEvent('blur', { bubbles: false }))
    await nextEventLoop()

    expect(rig.emitted).toEqual(['한', '글'])
    expect(rig.compositionView.classList.contains('active')).toBe(false)
  })

  it('lets Backspace decompose the open syllable without reaching the PTY', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })
    await typeJamo(rig, 'ㅏ', '하', { replaces: true })

    // The IME walks the syllable back a jamo at a time by rewriting the field.
    dispatchKey(rig, 'keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8 })
    rig.textarea.value = 'ㅎ'
    dispatchInput(rig, 'deleteContentBackward', null)
    await nextEventLoop()

    expect(rig.emitted).toEqual([])
    expect(rig.compositionView.textContent).toBe('ㅎ')
  })

  it('sends Backspace to the PTY once no syllable is open', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })

    dispatchKey(rig, 'keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8 })
    rig.textarea.value = ''
    dispatchInput(rig, 'deleteContentBackward', null)
    await nextEventLoop()
    expect(rig.emitted).toEqual([])

    dispatchKey(rig, 'keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8 })
    await nextEventLoop()
    expect(rig.emitted).toEqual(['\x7f'])
  })

  it('discards the open syllable on Escape, as a composition does', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })
    dispatchKey(rig, 'keydown', { key: 'Escape', code: 'Escape', keyCode: 27 })
    await nextEventLoop()

    expect(rig.emitted).toEqual([])
    expect(rig.textarea.value).toBe('')
    expect(rig.compositionView.classList.contains('active')).toBe(false)
  })

  it('sends a jamo the IME never composed, once the next keydown settles it', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    dispatchKey(rig, 'keydown', { key: 'ㅎ', keyCode: 'ㅎ'.charCodeAt(0) })
    await nextEventLoop()

    // Nothing is sent on a timer: the device delivers its write later than a
    // macrotask, so a deferred read that concluded "nothing was composed" would
    // fire first and send every jamo raw. The hold stays open instead.
    expect(rig.emitted).toEqual([])

    dispatchKey(rig, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })
    expect(rig.emitted).toEqual(['ㅎ', '\r'])
  })

  it('holds the jamo when the write lands after a full event loop turn', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    dispatchKey(rig, 'keydown', { key: 'ㅎ', keyCode: 'ㅎ'.charCodeAt(0) })
    await nextEventLoop()

    // The shape the device produces: the field is written only after the turn.
    rig.textarea.value = 'ㅎ'
    dispatchInput(rig, 'insertText', 'ㅎ')
    await nextEventLoop()

    expect(rig.emitted).toEqual([])
    expect(rig.compositionView.textContent).toBe('ㅎ')
  })

  it('keeps a screen reader on its existing path, so input cannot vanish', async () => {
    pretendIosWeb()
    const rig = openIosTerminal({ screenReaderMode: true })
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })

    expect(rig.preedit.heldText()).toBe('')
    expect(rig.compositionView.classList.contains('active')).toBe(false)
  })

  it('leaves the syllable held when an input event changes nothing', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })
    await typeJamo(rig, 'ㅏ', '하', { replaces: true })

    // A rewrite that lands on the same text is not the IME finishing `하`.
    dispatchInput(rig, 'insertText', '하')
    await nextEventLoop()

    expect(rig.emitted).toEqual([])
    expect(rig.preedit.heldText()).toBe('하')
  })

  it('does not commit a held syllable the field has stopped showing', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })

    // Longer than what is held, but not an extension of it: the IME respelled
    // the syllable rather than finishing it, so `ㅎ` is no longer owed.
    rig.textarea.value = '가나'
    dispatchInput(rig, 'insertText', '가나')
    await nextEventLoop()

    expect(rig.emitted).toEqual([])
    expect(rig.preedit.heldText()).toBe('가나')
  })

  it('commits the held syllable when the field is rewritten out from under it', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeHangeul(rig)

    // Not the IME rewriting its own syllable: the text the hold measures against
    // is gone entirely, so `글` is still owed to the PTY rather than droppable.
    rig.textarea.value = 'ls'
    dispatchInput(rig, 'insertText', 's')
    await nextEventLoop()

    expect(rig.emitted).toEqual(['한', '글'])
    expect(rig.preedit.heldText()).toBe('')
  })

  it('sends a jamo composed inside a session once, not twice', async () => {
    // The iPad on-screen keyboard does run a composition for Hangul, unlike the
    // hardware one. A hold opened over that session would commit the raw jamo
    // alongside xterm's own commit. `isComposing` is unreliable on a session's
    // keydowns — the reason xterm has a 229 path at all — so the session state
    // is what has to gate the hold.
    pretendIosWeb()
    const rig = openIosTerminal()
    dispatchComposition(rig, 'compositionstart', '')
    dispatchKey(rig, 'keydown', { key: 'ㅎ', keyCode: 'ㅎ'.charCodeAt(0) })
    dispatchComposition(rig, 'compositionupdate', 'ㅎ')
    rig.textarea.value = 'ㅎ'
    dispatchInput(rig, 'insertCompositionText', 'ㅎ', { isComposing: true })
    dispatchKey(rig, 'keydown', { key: 'ㅏ', keyCode: 'ㅏ'.charCodeAt(0) })
    dispatchComposition(rig, 'compositionupdate', '하')
    rig.textarea.value = '하'
    dispatchInput(rig, 'insertCompositionText', '하', { isComposing: true })
    dispatchComposition(rig, 'compositionend', '하')
    dispatchInput(rig, 'insertCompositionText', '하')
    await nextEventLoop()
    await nextEventLoop()

    expect(rig.emitted).toEqual(['하'])
  })

  it('claims the field write even once the key has been released', async () => {
    // xterm drops a composed `insertText` only while a key is down. When the
    // device delivers the write after the keyup, nothing but the claim keeps
    // xterm from sending the syllable a second time.
    pretendIosWeb()
    const rig = openIosTerminal()
    dispatchKey(rig, 'keydown', { key: 'ㅎ', keyCode: 'ㅎ'.charCodeAt(0) })
    dispatchKey(rig, 'keyup', { key: 'ㅎ', keyCode: 'ㅎ'.charCodeAt(0) })
    rig.textarea.value = 'ㅎ'
    dispatchInput(rig, 'insertText', 'ㅎ')
    await nextEventLoop()

    expect(rig.emitted).toEqual([])
    expect(rig.preedit.heldText()).toBe('ㅎ')
  })

  it('stands aside for composition-owned input without consulting session state', async () => {
    // Standing aside is read off the event, not off the tracker, so it cannot
    // depend on which `input` listener on the pane element runs first.
    pretendIosWeb()
    const rig = openIosTerminal({ isCompositionActive: () => false })
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })
    rig.textarea.value = 'ㅎ하'
    dispatchInput(rig, 'insertCompositionText', '하')
    await nextEventLoop()

    expect(rig.emitted).toEqual(['ㅎ'])
    expect(rig.preedit.heldText()).toBe('')
  })

  it('stands aside for a composition that starts over an open syllable', async () => {
    pretendIosWeb()
    const rig = openIosTerminal()
    await typeJamo(rig, 'ㅎ', 'ㅎ', { replaces: false })
    dispatchComposition(rig, 'compositionstart', '')

    expect(rig.emitted).toEqual(['ㅎ'])
    expect(rig.preedit.heldText()).toBe('')
  })
})
