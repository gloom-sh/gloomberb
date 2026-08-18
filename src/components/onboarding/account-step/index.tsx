import type { RefObject } from "react";
import type { InputRenderable } from "../../../ui";
import { AccountChooserPanel } from "./chooser-panel";
import { AccountFormPanel } from "./form-panel";
import { AccountQrPanel } from "./qr-panel";
import { AccountSignedInPanel } from "./signed-in-panel";
import type { AccountOutcome, AccountSub, AccountSubmitError } from "./model";

export interface AccountStepProps {
  sub: AccountSub;
  choiceIdx: number;
  onChoiceSelect: (index: number) => void;
  onChoiceActivate: (index: number) => void;
  email: string;
  password: string;
  fieldIdx: number;
  editing: boolean;
  inputRef: RefObject<InputRenderable | null>;
  submitting: boolean;
  submitError: AccountSubmitError | null;
  validationError: string | null;
  outcome: AccountOutcome | null;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onFieldFocus: (index: 0 | 1) => void;
  onSubmitField?: () => void;
  onQrApproved: (email: string) => void;
  height: number;
}

export function AccountStep(props: AccountStepProps) {
  if (props.sub === "signed-in") {
    return <AccountSignedInPanel outcome={props.outcome} />;
  }

  if (props.sub === "qr") {
    return <AccountQrPanel onApproved={props.onQrApproved} height={props.height} />;
  }

  if (props.sub === "signup" || props.sub === "login") {
    return (
      <AccountFormPanel
        mode={props.sub}
        email={props.email}
        password={props.password}
        fieldIdx={props.fieldIdx}
        editing={props.editing}
        inputRef={props.inputRef}
        submitting={props.submitting}
        submitError={props.submitError}
        validationError={props.validationError}
        onEmailChange={props.onEmailChange}
        onPasswordChange={props.onPasswordChange}
        onFieldFocus={props.onFieldFocus}
        onSubmitField={props.onSubmitField}
      />
    );
  }

  return (
    <AccountChooserPanel
      choiceIdx={props.choiceIdx}
      onChoiceSelect={props.onChoiceSelect}
      onChoiceActivate={props.onChoiceActivate}
    />
  );
}
