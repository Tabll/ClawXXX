/** The controlled child reports filesystem denial codes, not localized OS text. */
const DENIAL_EXIT_CODE = 77
const DENIAL_CODES = ['EACCES', 'EPERM', 'EROFS'] as const
const DENIAL_PREFIX = 'clawx-sandbox-write-denied/v1:'

export const SANDBOX_WRITE_PROBE = `
try {
  require('node:fs').writeFileSync(process.argv[1], 'sandbox-ok')
} catch (error) {
  if (!${JSON.stringify(DENIAL_CODES)}.includes(error.code)) throw error
  process.stderr.write(${JSON.stringify(DENIAL_PREFIX)} + JSON.stringify({ code: error.code, path: process.argv[1] }) + '\\n')
  process.exitCode = ${DENIAL_EXIT_CODE}
}
`

export function sandboxWriteWasDenied(
  result: { status: number | null, stderr: string },
  expectedPath: string,
): boolean {
  if (result.status !== DENIAL_EXIT_CODE) return false
  const lines = result.stderr.split(/\r?\n/)
  return DENIAL_CODES.some(code => lines.includes(
    DENIAL_PREFIX + JSON.stringify({ code, path: expectedPath }),
  ))
}
