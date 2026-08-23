export const PROMPT_SKILLS = [
  {
    aliases: ['computer', 'computer use', 'computer-use', 'browser'],
    id: 'computer-use',
    name: 'Computer Use',
  },
  {
    aliases: ['deep research', 'deep-research', 'deep_research'],
    id: 'deep-research',
    name: 'Deep Research',
  },
] as const

export type PromptSkillId = (typeof PROMPT_SKILLS)[number]['id']

function normalizeSkillQuery(value: string) {
  return value
    .replace(/^\s*\/\s*/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function matchPromptSkills(query: string) {
  const normalized = normalizeSkillQuery(query)
  if (!normalized) return PROMPT_SKILLS

  return PROMPT_SKILLS.filter((skill) =>
    [skill.id, skill.name, ...skill.aliases].some((candidate) =>
      normalizeSkillQuery(candidate).includes(normalized),
    ),
  )
}
