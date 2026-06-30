import { assertEquals, assertRejects, assertThrows } from 'jsr:@std/assert'
import {
  assertValidHostname,
  HOSTNAME_MAX_LENGTH,
  isValidHostname,
  parseHostnamePayload,
} from './contracts.ts'

Deno.test('isValidHostname mirrors instance rejection cases', () => {
  const reject = [
    'a b',
    'Web01',
    ';',
    '|',
    '$(reboot)',
    '`id`',
    '-a',
    'a-',
    '.a',
    'a.',
    '',
    'a'.repeat(254),
  ]
  for (const value of reject) {
    assertEquals(isValidHostname(value), false)
  }

  assertEquals(isValidHostname('web-01'), true)
  assertEquals(isValidHostname('host.example.com'), true)
  assertEquals(isValidHostname(`a${'b'.repeat(61)}c`), true)
  const labels = Array.from({ length: 40 }, (_, i) => `n${i}`).join('.')
  assertEquals(labels.length <= HOSTNAME_MAX_LENGTH, true)
  assertEquals(isValidHostname(labels), true)
})

Deno.test('assertValidHostname and parseHostnamePayload enforce hostname safety', () => {
  assertThrows(() => assertValidHostname('a;rm -rf /'), Error, 'Invalid hostname')
  assertEquals(parseHostnamePayload({ hostname: 'web-01' }), { hostname: 'web-01' })
  assertThrows(() => parseHostnamePayload(null), Error, 'Invalid hostname payload')
  assertThrows(
    () => parseHostnamePayload({ hostname: 'a b' }),
    Error,
    'Invalid hostname',
  )
})

Deno.test({
  name: 'handleHostname rejects when ansible runtime is missing',
  fn: async () => {
    const { handleHostname, setAnsibleAvailabilityCheckForTests } = await import(
      './hostname.ts'
    )

    setAnsibleAvailabilityCheckForTests(async () => false)
    try {
      const nowIso = new Date().toISOString()
      await assertRejects(
        () => handleHostname({ hostname: 'web-01' }, nowIso),
        Error,
        'Ansible/bootstrap runtime is missing',
      )
    } finally {
      setAnsibleAvailabilityCheckForTests(null)
    }
  },
})
