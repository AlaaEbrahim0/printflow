import { describe, expect, it } from 'vitest'
import { pipelineStatus } from './pipelineStatus'
import type { DesignVersion } from '../../api/client'

function version(
  id: string,
  stepType: DesignVersion['stepType'],
  parentId: string | null = null,
): DesignVersion {
  return {
    id,
    designId: 'd1',
    parentId,
    stepType,
    status: 'approved',
    widthPx: 1000,
    heightPx: 1000,
    hasAlpha: true,
    createdAt: '2026-01-01T00:00:00Z',
    fileUrl: `/${id}.png`,
    parameters: {},
  } as DesignVersion
}

describe('pipelineStatus', () => {
  it('reports nothing done for a bare original', () => {
    const versions = [version('v1', 'original')]
    expect(pipelineStatus(versions, 'v1')).toEqual({
      prepared: false,
      enhanced: false,
      sized: false,
    })
  })

  it('walks the whole ancestry, not just the current version', () => {
    const versions = [
      version('v1', 'original'),
      version('v2', 'trim', 'v1'),
      version('v3', 'upscale', 'v2'),
      version('v4', 'resize', 'v3'),
    ]
    expect(pipelineStatus(versions, 'v4')).toEqual({
      prepared: true,
      enhanced: true,
      sized: true,
    })
  })

  it('ignores steps that are not on the current lineage', () => {
    // v3 was an upscale that got rejected; the operator reverted to v2 and
    // resized from there, so enhancement is not part of the final artwork.
    const versions = [
      version('v1', 'original'),
      version('v2', 'trim', 'v1'),
      version('v3', 'upscale', 'v2'),
      version('v4', 'resize', 'v2'),
    ]
    expect(pipelineStatus(versions, 'v4')).toEqual({
      prepared: true,
      enhanced: false,
      sized: true,
    })
  })

  it('counts a manual crop as preparation', () => {
    const versions = [version('v1', 'original'), version('v2', 'crop', 'v1')]
    expect(pipelineStatus(versions, 'v2').prepared).toBe(true)
  })

  it('survives a missing current version id', () => {
    const versions = [version('v1', 'original'), version('v2', 'resize', 'v1')]
    expect(pipelineStatus(versions, null)).toEqual({
      prepared: false,
      enhanced: false,
      sized: false,
    })
  })

  it('survives a parent id that is not in the list', () => {
    const versions = [version('v2', 'resize', 'missing')]
    expect(pipelineStatus(versions, 'v2')).toEqual({
      prepared: false,
      enhanced: false,
      sized: true,
    })
  })

  it('terminates on a cyclic parent chain instead of looping forever', () => {
    // Corrupt data should degrade to "whatever we saw", never hang the page.
    const versions = [version('a', 'trim', 'b'), version('b', 'trim', 'a')]
    expect(pipelineStatus(versions, 'a').prepared).toBe(true)
  })
})
