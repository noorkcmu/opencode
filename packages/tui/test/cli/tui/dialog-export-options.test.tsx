/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import type { DialogExportOptionsResult } from "../../../src/ui/dialog-export-options"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function findTextPosition<F extends { lines: { spans: { text: string; width: number }[] }[] }>(
  frame: F,
  text: string,
) {
  for (let y = 0; y < frame.lines.length; y++) {
    let x = 0
    for (const span of frame.lines[y]!.spans) {
      if (span.text.includes(text)) return { x, y }
      x += span.width
    }
  }
  throw new Error(`text not found in captured frame: ${text}`)
}

async function mountExportOptions(input: { root: string; defaults: DialogExportOptionsResult }) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const [
    { DialogProvider, useDialog },
    { DialogExportOptions },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/ui/dialog-export-options"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/keymap"),
  ])

  let result: Promise<DialogExportOptionsResult | null> | undefined

  function Body() {
    const dialog = useDialog()
    onMount(() => {
      result = DialogExportOptions.show(dialog, input.defaults)
    })
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({ leader_timeout: 1000 })
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)

    return (
      <TestTuiContexts
        directory={input.root}
        paths={{
          home: input.root,
          state,
          worktree: input.root,
        }}
      >
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <Body />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true })
  await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)

  return {
    app,
    get result() {
      if (!result) throw new Error("DialogExportOptions.show was not called")
      return result
    },
    async cleanup() {
      app.renderer.destroy()
    },
  }
}

test("DialogExportOptions.show renders the given defaults and resolves them unchanged on confirm", async () => {
  await using tmp = await tmpdir()
  const defaults: DialogExportOptionsResult = {
    filename: "session-abc123.md",
    thinking: true,
    toolDetails: false,
    assistantMetadata: true,
    openWithoutSaving: false,
  }

  const dialog = await mountExportOptions({ root: tmp.path, defaults })
  try {
    const textarea = dialog.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused filename textarea")
    expect(textarea.plainText).toBe(defaults.filename)

    dialog.app.mockInput.pressEnter()

    await expect(dialog.result).resolves.toEqual(defaults)
  } finally {
    await dialog.cleanup()
  }
})

test("DialogExportOptions.show resolves null when the dialog is dismissed", async () => {
  await using tmp = await tmpdir()
  const defaults: DialogExportOptionsResult = {
    filename: "session-xyz789.md",
    thinking: false,
    toolDetails: true,
    assistantMetadata: false,
    openWithoutSaving: true,
  }

  const dialog = await mountExportOptions({ root: tmp.path, defaults })
  try {
    const textarea = dialog.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused filename textarea")
    expect(textarea.plainText).toBe(defaults.filename)

    await dialog.app.flush()
    const frame = dialog.app.captureCharFrame()
    expect(frame.match(/\[x\]/g)?.length).toBe(2)
    expect(frame.match(/\[ \]/g)?.length).toBe(2)

    dialog.app.mockInput.pressEscape()

    await expect(dialog.result).resolves.toBeNull()
  } finally {
    await dialog.cleanup()
  }
})

test("DialogExportOptions.show lets tab cycle options and space toggle each one", async () => {
  await using tmp = await tmpdir()
  const defaults: DialogExportOptionsResult = {
    filename: "session-toggle-me.md",
    thinking: false,
    toolDetails: false,
    assistantMetadata: false,
    openWithoutSaving: false,
  }

  const dialog = await mountExportOptions({ root: tmp.path, defaults })
  try {
    const textarea = dialog.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused filename textarea")

    // Cycle filename -> thinking -> toolDetails -> assistantMetadata -> openWithoutSaving,
    // toggling each option on with space, then tab once more to wrap back to filename.
    dialog.app.mockInput.pressTab()
    dialog.app.mockInput.pressKey(" ")
    dialog.app.mockInput.pressTab()
    dialog.app.mockInput.pressKey(" ")
    dialog.app.mockInput.pressTab()
    dialog.app.mockInput.pressKey(" ")
    dialog.app.mockInput.pressTab()
    dialog.app.mockInput.pressKey(" ")
    dialog.app.mockInput.pressTab()

    await dialog.app.flush()
    const frame = dialog.app.captureCharFrame()
    expect(frame.match(/\[x\]/g)?.length).toBe(4)
    expect(frame.match(/\[ \]/g)).toBeNull()

    dialog.app.mockInput.pressEnter()

    await expect(dialog.result).resolves.toEqual({
      filename: defaults.filename,
      thinking: true,
      toolDetails: true,
      assistantMetadata: true,
      openWithoutSaving: true,
    })
  } finally {
    await dialog.cleanup()
  }
})

test("DialogExportOptions.show lets the mouse select each option and close the dialog", async () => {
  await using tmp = await tmpdir()
  const defaults: DialogExportOptionsResult = {
    filename: "session-mouse.md",
    thinking: false,
    toolDetails: false,
    assistantMetadata: false,
    openWithoutSaving: false,
  }

  const dialog = await mountExportOptions({ root: tmp.path, defaults })
  try {
    const textarea = dialog.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused filename textarea")

    await dialog.app.flush()
    for (const label of ["Include thinking", "Include tool details", "Include assistant metadata", "Open without saving"]) {
      const { x, y } = findTextPosition(dialog.app.captureSpans(), label)
      await dialog.app.mockMouse.click(x, y)
      await dialog.app.flush()
    }

    const frame = dialog.app.captureCharFrame()
    expect(frame.match(/\[x\]/g)).toBeNull()

    const { x, y } = findTextPosition(dialog.app.captureSpans(), "esc")
    await dialog.app.mockMouse.click(x, y)

    await expect(dialog.result).resolves.toBeNull()
  } finally {
    await dialog.cleanup()
  }
})
