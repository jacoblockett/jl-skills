import { extname } from 'node:path'

export function escapeTomlBasicString(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\b', '\\b')
    .replaceAll('\t', '\\t')
    .replaceAll('\n', '\\n')
    .replaceAll('\f', '\\f')
    .replaceAll('\r', '\\r')
    .replaceAll('"', '\\"')
}

export function renderResource(
  text: string,
  tokens: Record<string, string>,
  destination: string,
): string {
  const toml = extname(destination).toLowerCase() === '.toml'
  let result = text
  for (const [from, value] of Object.entries(tokens)) {
    result = result.replaceAll(from, toml ? escapeTomlBasicString(value) : value)
  }
  return result
}
