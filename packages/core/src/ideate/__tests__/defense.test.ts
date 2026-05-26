import { describe, it, expect } from 'vitest';
import { 
  parseDefenseOutput, 
  buildDefenseUserPrompt 
} from '../defense.js';
import type { Problem } from '../types.js';

describe('Defense Parser', () => {
  it('should parse valid defense JSON', () => {
    const json = `{
      "defenses": [
        {
          "critique_id": "0",
          "stance": "address",
          "reasoning": "I agree this is a risk.",
          "draft_delta": "Added authentication layer."
        },
        {
          "critique_id": "1",
          "stance": "double_down",
          "reasoning": "The market is larger than the critic thinks."
        }
      ]
    }`;
    const result = parseDefenseOutput(json);
    expect(result).not.toBeNull();
    expect(result?.defenses).toHaveLength(2);
    expect(result?.defenses[0].stance).toBe('address');
    expect(result?.defenses[1].stance).toBe('double_down');
  });

  it('should handle markdown-wrapped JSON', () => {
    const json = '```json\n{"defenses": []}\n```';
    const result = parseDefenseOutput(json);
    expect(result).not.toBeNull();
  });

  it('should reject missing required fields', () => {
    const json = `{ "defenses": [{ "critique_id": "0", "stance": "address" }] }`; // missing reasoning
    const result = parseDefenseOutput(json);
    expect(result?.defenses).toHaveLength(0);
  });

  it('should reject address without draft_delta', () => {
    const json = `{ 
      "defenses": [{ "critique_id": "0", "stance": "address", "reasoning": "fix it" }] 
    }`;
    const result = parseDefenseOutput(json);
    expect(result?.defenses).toHaveLength(0);
  });

  it('should accept double_down without draft_delta', () => {
    const json = `{ 
      "defenses": [{ "critique_id": "0", "stance": "double_down", "reasoning": "no fix needed" }] 
    }`;
    const result = parseDefenseOutput(json);
    expect(result?.defenses).toHaveLength(1);
  });

  it('should return null for invalid JSON', () => {
    expect(parseDefenseOutput('not json')).toBeNull();
  });
});

describe('Defense Prompt Builder', () => {
  const idea = 'A magic toaster';
  const draft = 'Toasts bread magically.';
  const critiques: readonly Problem[] = [
    { problem: 'Too hot', proposed_fix: 'Add fan', dimension: 'technical' },
  ];

  it('should include mode instructions for author_choice', () => {
    const prompt = buildDefenseUserPrompt(idea, draft, critiques, 'author_choice');
    expect(prompt).toContain('Choose the most honest stance');
  });

  it('should include mode instructions for address', () => {
    const prompt = buildDefenseUserPrompt(idea, draft, critiques, 'address');
    expect(prompt).toContain('You MUST "address" every critique');
  });

  it('should include mode instructions for double_down', () => {
    const prompt = buildDefenseUserPrompt(idea, draft, critiques, 'double_down');
    expect(prompt).toContain('You MUST "double down" on every critique');
  });
});
