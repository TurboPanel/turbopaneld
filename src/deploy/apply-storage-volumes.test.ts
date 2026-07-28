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
          volumeName: 'tp-00000000-cache',
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
    assertEquals(patched.includes('external: true'), true)
  })

  it('emits external:true for docker_volume and skips mount without destinationPath', () => {
    const composeYaml = [
      'services:',
      '  web:',
      '    image: nginx:latest',
      '    volumes:',
      '      - data:/data',
      'volumes:',
      '  data: {}',
    ].join('\n')

    const volumeId = '01936b3e-8c7a-7b2d-a1f0-123456789abc'
    const patched = applyStorageVolumesToCompose(
      composeYaml,
      [
        {
          storageId: volumeId,
          kind: 'docker_volume',
          name: 'data',
          serverId: 'srv',
          volumeName: volumeId,
        },
      ],
      new Map([[volumeId, volumeId]]),
    )

    assertEquals(patched.includes('external: true'), true)
    assertEquals(patched.includes(`name: ${volumeId}`), true)
    // No service mount append — compose already references the volume.
    assertEquals(patched.includes('target:'), false)
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
