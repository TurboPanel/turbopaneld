import { assertEquals, assertThrows } from 'jsr:@std/assert'
import { describe, it } from '@std/testing/bdd'
import { applyStorageVolumesToCompose } from './apply-storage-volumes.ts'

describe('applyStorageVolumesToCompose', () => {
  it('patches bind mounts and docker volumes into compose services', () => {
    const composeYaml = [
      'services:',
      '  web:',
      '    image: nginx:latest',
    ].join('\n')

    const patched = applyStorageVolumesToCompose(
      composeYaml,
      [
        {
          storageId: 'st-bind',
          kind: 'bind_mount',
          name: 'data',
          destinationPath: '/data',
          composeServiceName: 'web',
          serverId: 'srv',
        },
        {
          storageId: 'st-vol',
          kind: 'docker_volume',
          name: 'cache',
          destinationPath: '/cache',
          composeServiceName: 'web',
          serverId: 'srv',
        },
      ],
      new Map([
        ['st-bind', '/var/lib/tp/data'],
        ['st-vol', 'tp-00000000-cache'],
      ]),
    )

    assertEquals(patched.includes('/var/lib/tp/data'), true)
    assertEquals(patched.includes('/data'), true)
    assertEquals(patched.includes('tp-00000000-cache'), true)
    assertEquals(patched.includes('/cache'), true)
  })

  it('throws when compose service is missing', () => {
    assertThrows(
      () => applyStorageVolumesToCompose(
        'services:\n  web:\n    image: nginx:latest',
        [{
          storageId: 'st1',
          kind: 'bind_mount',
          name: 'data',
          destinationPath: '/data',
          composeServiceName: 'missing',
          serverId: 'srv',
        }],
        new Map([['st1', '/host/data']]),
      ),
      Error,
      'Compose service missing not found',
    )
  })
})
