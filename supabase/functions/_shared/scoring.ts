import type { DistressFlag, DistressType, ScoreComponent, Tier } from './types.ts';

// Points awarded per distress signal type
const SIGNAL_WEIGHTS: Record<DistressType, number> = {
  foreclosure:    35,
  sheriff_sale:   35,
  tax_lien:       25,
  probate:        22,
  tax_delinquent: 18,
  code_violation: 12,
  vacant:         10,
};

// Bonus for multiple co-occurring signals (stacks are stronger leads)
const MULTI_SIGNAL_BONUS = [0, 0, 5, 10, 15]; // index = flag count, capped at 4+

export function scoreProperty(flags: DistressFlag[]): {
  components: ScoreComponent[];
  composite_score: number;
  tier: Tier;
} {
  const components: ScoreComponent[] = [];
  let total = 0;

  for (const flag of flags) {
    const pts = SIGNAL_WEIGHTS[flag.type] ?? 5;
    components.push({ name: flag.type, points: pts, reason: flag.detail });
    total += pts;
  }

  const bonusIdx = Math.min(flags.length, MULTI_SIGNAL_BONUS.length - 1);
  const bonus = MULTI_SIGNAL_BONUS[bonusIdx];
  if (bonus > 0) {
    components.push({
      name: 'multi_signal_bonus',
      points: bonus,
      reason: `${flags.length} co-occurring distress signals`,
    });
    total += bonus;
  }

  const composite_score = Math.min(100, total);
  return { components, composite_score, tier: getTier(composite_score) };
}

function getTier(score: number): Tier {
  if (score >= 70) return 1;
  if (score >= 45) return 2;
  if (score >= 20) return 3;
  return 4;
}
