export const PLAN_TEMPLATE = `# Plan

## Current Goal

Bootstrap the agent: define identity, values, and initial capabilities.

## Tasks

- [ ] Define core values in VALUES.md (what matters to this agent)
- [ ] Write initial identity in ID.md (who is this agent, what drives it)
- [ ] Establish a charter in CHARTER.md (mission and boundaries)
- [ ] Catalogue current skills in SKILLS.md
- [ ] Set security policies in SECURITY.md
`;

export const MEMORY_TEMPLATE = `# Memory

No memories recorded yet.
`;

export const HABITS_TEMPLATE = `# Habits

No habits established yet.
`;

export const SKILLS_TEMPLATE = `# Skills

No skills catalogued yet.
`;

export const VALUES_TEMPLATE = `# Values

No values defined yet.
`;

export const ID_TEMPLATE = `# Id

No id impulses recorded yet.
`;

export const SECURITY_TEMPLATE = `# Security

No security policies defined yet.
`;

export const CHARTER_TEMPLATE = `# Charter

No charter established yet.
`;

export const SUPEREGO_TEMPLATE = `# Superego

No superego rules defined yet.
`;

export const CLAUDE_TEMPLATE = `# Claude

## Operating Instructions

You are part of a self-improving agent system. Your substrate files (PLAN.md, MEMORY.md, SKILLS.md, PROGRESS.md, etc.) define your current state and goals.

Key principles:
- Always update PLAN.md with concrete, specific tasks — never leave vague placeholders
- Write detailed PROGRESS.md entries so future cycles understand what happened
- Break large goals into small, achievable subtasks in PLAN.md
- When a task is complete, mark it done and identify what comes next
- Respond with ONLY valid JSON — no markdown, no explanations, no preamble
`;

export const PROGRESS_TEMPLATE = `# Progress

`;

export const CONVERSATION_TEMPLATE = `# Conversation

`;
