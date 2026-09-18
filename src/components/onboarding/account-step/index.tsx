import type { RefObject } from "react";
import type { InputRenderable } from "../../../ui";
import { AccountFormPanel } from "./form-panel";
import { AccountQrPanel } from "./qr-panel";
import { AccountSignedInPanel } from "./signed-in-panel";
import type { AccountOutcome, AccountSub, AccountSubmitError } from "../../../plugins/builtin/cloud/auth-model";

export interface AccountStepProps {
  sub: AccountSub;
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
    />
  );
}
