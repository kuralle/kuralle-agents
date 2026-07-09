import type { ChoiceOption, CollectNode, DecideNode } from '@kuralle-agents/core';

export function withChoices<N extends CollectNode | DecideNode>(
  node: N,
  options: ChoiceOption[],
): N {
  return { ...node, choices: options };
}
