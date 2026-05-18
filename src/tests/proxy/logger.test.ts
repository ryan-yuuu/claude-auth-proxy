import { describe, expect, test } from 'bun:test'
import { fields, Logger, redact } from '../../proxy/logger'

function captureLogger(level: 'info' | 'debug' = 'info') {
  const lines: string[] = []
  const logger = new Logger(level, (line) => lines.push(line))
  return { logger, lines }
}

describe('redact', () => {
  test('redacts sk-ant-oat tokens', () => {
    expect(redact('token=sk-ant-oat01-AAAA-BBBB_CC-DD')).toBe(
      'token=sk-ant-oat<redacted>',
    )
  })

  test('redacts sk-ant-api tokens', () => {
    expect(redact('key=sk-ant-api03-XYZ')).toBe('key=sk-ant-api<redacted>')
  })

  test('redacts Bearer tokens case-insensitively', () => {
    expect(redact('authorization: Bearer abc.def_ghi')).toBe(
      'authorization: Bearer <redacted>',
    )
    expect(redact('authorization: bearer abc.def_ghi')).toBe(
      'authorization: bearer <redacted>',
    )
  })

  test('redacts JSON access_token and refresh_token fields', () => {
    const input = '{"access_token":"abc123","refresh_token":"xyz789"}'
    expect(redact(input)).toBe(
      '{"access_token":"<redacted>","refresh_token":"<redacted>"}',
    )
  })

  test('redacts JSON access and refresh short fields', () => {
    const input = '{"access":"abc","refresh":"xyz"}'
    expect(redact(input)).toBe('{"access":"<redacted>","refresh":"<redacted>"}')
  })

  test('leaves non-sensitive content alone', () => {
    expect(redact('hello world model=claude-opus-4-6 tools=3')).toBe(
      'hello world model=claude-opus-4-6 tools=3',
    )
  })
})

describe('fields', () => {
  test('formats simple key=value pairs', () => {
    expect(fields({ id: 'abc', count: 3 })).toBe('id=abc count=3')
  })

  test('quotes values with whitespace', () => {
    expect(fields({ name: 'hello world' })).toBe('name="hello world"')
  })

  test('quotes values containing double quotes', () => {
    expect(fields({ note: 'has "quotes"' })).toBe('note="has \\"quotes\\""')
  })

  test('renders null/undefined as empty', () => {
    expect(fields({ a: null, b: undefined, c: 'x' })).toBe('a= b= c=x')
  })
})

describe('Logger', () => {
  test('info emits a stamped line', () => {
    const { logger, lines } = captureLogger('info')
    logger.info('hello world')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] hello world\n$/,
    )
  })

  test('debug is suppressed at info level', () => {
    const { logger, lines } = captureLogger('info')
    logger.debug('detail')
    expect(lines).toHaveLength(0)
  })

  test('debug is emitted at debug level', () => {
    const { logger, lines } = captureLogger('debug')
    logger.debug('detail')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('detail')
  })

  test('plain emits without a timestamp', () => {
    const { logger, lines } = captureLogger('info')
    logger.plain('Visit https://example.com to continue')
    expect(lines).toEqual(['Visit https://example.com to continue\n'])
  })

  test('redacts tokens in emitted lines', () => {
    const { logger, lines } = captureLogger('info')
    logger.info(
      'access=sk-ant-oat01-foo header="Authorization: Bearer abc.def"',
    )
    expect(lines[0]).toContain('sk-ant-oat<redacted>')
    expect(lines[0]).toContain('Bearer <redacted>')
    expect(lines[0]).not.toContain('abc.def')
  })

  test('redacts even from the plain helper', () => {
    const { logger, lines } = captureLogger('info')
    logger.plain('debug dump: {"access_token":"secret"}')
    expect(lines[0]).toContain('"access_token":"<redacted>"')
  })
})
