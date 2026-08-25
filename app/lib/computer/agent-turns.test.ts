import { describe, expect, test } from 'bun:test'
import {
  Agent,
  MaxTurnsExceededError,
  RunState,
  Runner,
  tool,
} from '@openai/agents'
import {
  assistantMessage,
  functionCall,
  ScriptedModel,
} from '@openai/agents/testing'
import { z } from 'zod'

import {
  COMPUTER_AGENT_TURNS_PER_SEGMENT,
  MAX_COMPUTER_AGENT_TURNS,
  computerAgentTurnLimit,
  formatComputerToolOutput,
} from '../../../shared/computer-agent'

describe('computer visual tool output', () => {
  test('gives the model an image without copying base64 into text metadata', () => {
    const output = formatComputerToolOutput('computer_desktop_click', {
      ok: true,
      result: {
        action: 'click',
        elapsedMs: 42,
        screenshot: {
          base64: 'abc123',
          capturedAt: '2026-08-24T00:00:00.000Z',
          height: 1080,
          mimeType: 'image/jpeg',
          url: 'desktop://khloei',
          width: 1920,
        },
      },
    })

    expect(Array.isArray(output)).toBe(true)
    if (!Array.isArray(output)) throw new Error('Expected structured output.')
    expect(output[0]?.type).toBe('text')
    expect(output[0]?.text).not.toContain('abc123')
    expect(output[1]).toEqual({
      detail: 'high',
      image: 'data:image/jpeg;base64,abc123',
      type: 'image',
    })
  })

  test('still sends an image when an older computer omits the mime type', () => {
    // schema.ts keeps mimeType optional, where absent means the original PNG
    // contract, so a version-skewed service must not push base64 into the text.
    const output = formatComputerToolOutput('computer_desktop_screenshot', {
      ok: true,
      result: {
        base64: 'abc123',
        capturedAt: '2026-08-24T00:00:00.000Z',
        height: 1080,
        url: 'desktop://khloei',
        width: 1920,
      },
    })

    expect(Array.isArray(output)).toBe(true)
    if (!Array.isArray(output)) throw new Error('Expected structured output.')
    expect(output[0]?.text).not.toContain('abc123')
    expect(output[1]).toEqual({
      detail: 'high',
      image: 'data:image/png;base64,abc123',
      type: 'image',
    })
  })

  test('never builds a data url from an unrecognized mime type', () => {
    const output = formatComputerToolOutput('computer_desktop_click', {
      ok: true,
      result: {
        action: 'click',
        elapsedMs: 5,
        screenshot: {
          base64: 'abc123',
          capturedAt: '2026-08-24T00:00:00.000Z',
          height: 1080,
          mimeType: 'text/html',
          url: 'desktop://khloei',
          width: 1920,
        },
      },
    })

    expect(Array.isArray(output)).toBe(true)
    if (!Array.isArray(output)) throw new Error('Expected structured output.')
    expect(output[1]).toEqual({
      detail: 'high',
      image: 'data:image/png;base64,abc123',
      type: 'image',
    })
  })

  test('keeps ordinary computer outcomes as JSON text', () => {
    expect(
      formatComputerToolOutput('computer_read', {
        ok: true,
        result: { title: 'Khloei' },
      }),
    ).toBe('{"ok":true,"result":{"title":"Khloei"}}')
  })
})

describe('computer agent segmented turn budget', () => {
  test('starts with one bounded SDK segment', () => {
    expect(
      computerAgentTurnLimit({
        currentTurn: 0,
        currentTurnInProgress: false,
      }),
    ).toBe(COMPUTER_AGENT_TURNS_PER_SEGMENT)
  })

  test('automatically opens the next segment for a saved boundary turn', () => {
    expect(
      computerAgentTurnLimit({
        currentTurn: COMPUTER_AGENT_TURNS_PER_SEGMENT,
        currentTurnInProgress: false,
      }),
    ).toBe(COMPUTER_AGENT_TURNS_PER_SEGMENT * 2)
    expect(
      computerAgentTurnLimit({
        currentTurn: COMPUTER_AGENT_TURNS_PER_SEGMENT + 1,
        currentTurnInProgress: true,
      }),
    ).toBe(COMPUTER_AGENT_TURNS_PER_SEGMENT * 2)
  })

  test('recovers the correct cumulative ceiling from a mid-segment checkpoint', () => {
    expect(
      computerAgentTurnLimit({
        currentTurn: COMPUTER_AGENT_TURNS_PER_SEGMENT + 7,
        currentTurnInProgress: false,
      }),
    ).toBe(COMPUTER_AGENT_TURNS_PER_SEGMENT * 2)
  })

  test('retains a hard per-request ceiling', () => {
    expect(
      computerAgentTurnLimit({
        currentTurn: MAX_COMPUTER_AGENT_TURNS + 1,
        currentTurnInProgress: true,
      }),
    ).toBeNull()
  })

  test('resumes the serialized SDK state instead of stopping at turn 24', async () => {
    const executedSteps: number[] = []
    const recordStep = tool({
      name: 'record_step',
      description: 'Record one deterministic test step.',
      parameters: z.object({ step: z.number().int().nonnegative() }).strict(),
      execute: ({ step }) => {
        executedSteps.push(step)
        return `recorded ${step}`
      },
    })
    const model = new ScriptedModel([
      ...Array.from({ length: COMPUTER_AGENT_TURNS_PER_SEGMENT }, (_, step) => [
        functionCall('record_step', { step }, { callId: `call-${step}` }),
      ]),
      [assistantMessage('completed')],
    ])
    const agent = new Agent({
      name: 'turn budget fixture',
      instructions: 'Follow the scripted model responses.',
      model,
      tools: [recordStep],
    })
    const runner = new Runner({ tracingDisabled: true })
    let input: string | RunState<unknown, typeof agent> = 'start'
    let turnLimit = COMPUTER_AGENT_TURNS_PER_SEGMENT
    let boundaryCount = 0
    let finalOutput: unknown

    for (;;) {
      try {
        const result = await runner.run(agent, input, {
          maxTurns: turnLimit,
        })
        finalOutput = result.finalOutput
        break
      } catch (error) {
        if (!(error instanceof MaxTurnsExceededError) || !error.state) {
          throw error
        }

        boundaryCount += 1
        const resumedState = await RunState.fromString(
          agent,
          error.state.toString(),
        )
        const nextTurnLimit = computerAgentTurnLimit(resumedState.toJSON())
        expect(nextTurnLimit).not.toBeNull()
        expect(nextTurnLimit).toBeGreaterThan(turnLimit)
        input = resumedState
        turnLimit = nextTurnLimit!
      }
    }

    expect(boundaryCount).toBe(1)
    expect(finalOutput).toBe('completed')
    expect(model.calls).toHaveLength(COMPUTER_AGENT_TURNS_PER_SEGMENT + 1)
    expect(model.remainingSteps).toBe(0)
    expect(executedSteps).toEqual(
      Array.from(
        { length: COMPUTER_AGENT_TURNS_PER_SEGMENT },
        (_, step) => step,
      ),
    )
  })
})
