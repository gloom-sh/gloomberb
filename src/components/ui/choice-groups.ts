interface ChoiceGroupHeading {
  id: string;
  label: string;
  kind: "heading";
  disabled: true;
}

/** Label each contiguous group without changing the order or identity of its choices. */
export function withChoiceGroupHeadings<T extends { group?: string }>(choices: readonly T[]): Array<T | ChoiceGroupHeading> {
  let previousGroup: string | undefined;
  return choices.flatMap((choice, index): Array<T | ChoiceGroupHeading> => {
    const heading = choice.group && choice.group !== previousGroup
      ? { id: `\u0000group:${index}`, label: choice.group, kind: "heading" as const, disabled: true as const }
      : null;
    previousGroup = choice.group;
    return heading ? [heading, choice] : [choice];
  });
}
