type Choice = { value: string; label?: string; aliases?: readonly string[] };

const choiceToken = (value: string) => value.trim().toLowerCase().replace(/[\s_.-]+/g, "");

export function matchOptionChoice<ChoiceType extends Choice>(choices: readonly ChoiceType[], typed: string): ChoiceType | undefined {
  const token = choiceToken(typed);
  return choices.find((choice) => choiceToken(choice.value) === token)
    ?? choices.find((choice) => (choice.label && choiceToken(choice.label) === token)
      || choice.aliases?.some((alias) => choiceToken(alias) === token));
}

export function optionChoiceNames(choices: readonly Choice[]): string {
  return choices.map(({ value, label }) => label && choiceToken(label) !== choiceToken(value)
    ? `"${label}" (${value})` : value).join(", ");
}
