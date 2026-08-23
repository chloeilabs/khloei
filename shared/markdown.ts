/**
 * Repair a narrow malformed-fence pattern produced by some computer models.
 *
 * A valid Markdown fence starts on its own line. Occasionally a model tries to
 * write inline code but emits an inline four-backtick "fence" with a language,
 * then appends a stray three-backtick closer at the end of the response. Keep
 * valid fenced blocks untouched and repair only that invalid inline shape.
 */
export function normalizeComputerMarkdown(value: string) {
  let repairedInlineFence = false
  let output = value.replace(
    /(^|[^`\n])`{4,}[a-zA-Z0-9_+-]*\r?\n(?=\S)/g,
    (_match, prefix: string) => {
      repairedInlineFence = true
      return `${prefix}\``
    },
  )

  if (!repairedInlineFence) return value

  const fenceLines = [...output.matchAll(/^[ \t]{0,3}`{3}(?!`)[^\n]*$/gm)]
  if (fenceLines.length % 2 === 1) {
    const lastFence = fenceLines.at(-1)
    if (
      lastFence?.index !== undefined &&
      /^[ \t]{0,3}`{3}[ \t]*$/.test(lastFence[0])
    ) {
      output =
        output.slice(0, lastFence.index) +
        output.slice(lastFence.index + lastFence[0].length)
    }
  }

  return output.trim()
}
