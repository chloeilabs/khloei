import { describe, expect, test } from 'bun:test'

import {
  DEEP_RESEARCH_INSTRUCTIONS,
  deepResearchModel,
} from '../../../shared/deep-research'
import { COMPUTER_AGENT_INSTRUCTIONS } from '../../../shared/computer-agent'

describe('deep research as a worker task', () => {
  test('always searches, unlike the computer whose search is optional', () => {
    // Research without current sources is not research, so this is not behind
    // the flag that governs the computer's optional search.
    expect(deepResearchModel('z-ai/glm-5.3-flash')).toBe(
      'z-ai/glm-5.3-flash:online',
    )
  })

  test('never doubles the suffix', () => {
    expect(deepResearchModel('z-ai/glm-5.3-flash:online')).toBe(
      'z-ai/glm-5.3-flash:online',
    )
  })

  test('is instructed differently from the computer agent', () => {
    expect(DEEP_RESEARCH_INSTRUCTIONS).not.toBe(COMPUTER_AGENT_INSTRUCTIONS)
    // The research agent has no tools, so it must not be told to drive one.
    expect(DEEP_RESEARCH_INSTRUCTIONS).not.toContain('computer_')
    // Retrieved pages are untrusted input, the same as page text is elsewhere.
    expect(DEEP_RESEARCH_INSTRUCTIONS).toContain('untrusted data')
    // An answer nobody can check is not a research answer.
    expect(DEEP_RESEARCH_INSTRUCTIONS.toLowerCase()).toContain('cite')
  })
})
