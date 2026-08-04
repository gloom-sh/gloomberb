import type { Dispatch, SetStateAction } from "react";
import { resolveBrokerConfigFields, type BrokerConfigField } from "../../types/broker";
import { isBackNavigationKey, isPlainEscape } from "../../utils/back-navigation";
import { isPlainKey } from "../../utils/keyboard";
import type { ListViewItem } from "../ui";
import { useShortcut } from "../../react/input";
import {
  ACCOUNT_CHOICE_IDS,
  type AccountMode,
  type AccountSub,
  type AccountSubmitError,
} from "./account-step/model";
import type { PortfolioSub } from "./onboarding-steps";
import type { BrokerOption, OnboardingStep } from "./wizard-model";

export function useOnboardingKeyboard({
  step,
  portfolioSub,
  setPortfolioSub,
  themeIds,
  setThemeIdx,
  portfolioChoices,
  portfolioOptionIdx,
  setPortfolioOptionIdx,
  brokerOptions,
  brokerValues,
  selectedBrokerId,
  setSelectedBrokerId,
  activeBrokerFields,
  brokerFieldIdx,
  setBrokerFieldIdx,
  brokerSelectIdx,
  setBrokerSelectIdx,
  editingField,
  setEditingField,
  isBrokerSyncing,
  brokerSyncError,
  accountSub,
  accountChoiceIdx,
  setAccountChoiceIdx,
  accountSubmitting,
  accountSubmitError,
  beginAccountMode,
  returnToAccountChooser,
  switchToAccountLogin,
  submitAccountField,
  submitAccount,
  isFinishing,
  nextStep,
  prevStep,
  finish,
  resetBrokerSync,
  setBrokerFieldValue,
  syncSelectedBroker,
}: {
  step: OnboardingStep;
  portfolioSub: PortfolioSub;
  setPortfolioSub: Dispatch<SetStateAction<PortfolioSub>>;
  themeIds: string[];
  setThemeIdx: Dispatch<SetStateAction<number>>;
  portfolioChoices: ListViewItem[];
  portfolioOptionIdx: number;
  setPortfolioOptionIdx: Dispatch<SetStateAction<number>>;
  brokerOptions: BrokerOption[];
  brokerValues: Record<string, Record<string, string>>;
  selectedBrokerId: string | null;
  setSelectedBrokerId: Dispatch<SetStateAction<string | null>>;
  activeBrokerFields: BrokerConfigField[];
  brokerFieldIdx: number;
  setBrokerFieldIdx: Dispatch<SetStateAction<number>>;
  brokerSelectIdx: number;
  setBrokerSelectIdx: Dispatch<SetStateAction<number>>;
  editingField: boolean;
  setEditingField: Dispatch<SetStateAction<boolean>>;
  isBrokerSyncing: boolean;
  brokerSyncError: string | null;
  accountSub: AccountSub;
  accountChoiceIdx: number;
  setAccountChoiceIdx: Dispatch<SetStateAction<number>>;
  accountSubmitting: boolean;
  accountSubmitError: AccountSubmitError | null;
  beginAccountMode: (mode: AccountMode) => void;
  returnToAccountChooser: () => void;
  switchToAccountLogin: () => void;
  submitAccountField: () => void;
  submitAccount: () => void;
  isFinishing: boolean;
  nextStep: () => void;
  prevStep: () => void;
  finish: () => void;
  resetBrokerSync: () => void;
  setBrokerFieldValue: (brokerId: string, key: string, value: string) => void;
  syncSelectedBroker: (brokerValueOverrides?: Record<string, string>) => Promise<void>;
}) {
  useShortcut((event) => {
    if (isFinishing) {
      return;
    }

    if (editingField) {
      if (event.name === "enter" || event.name === "return") {
        setEditingField(false);
        if (step === "account") {
          submitAccountField();
          return;
        }
        if (portfolioSub === "broker-fields" && selectedBrokerId) {
          const currentField = activeBrokerFields[brokerFieldIdx];
          if (!currentField) {
            void syncSelectedBroker();
            return;
          }
          const rawValue = brokerValues[selectedBrokerId]?.[currentField.key] ?? "";
          const currentValue = rawValue.trim() || currentField.defaultValue || "";
          if (currentValue) {
            const nextValues = {
              ...(brokerValues[selectedBrokerId] ?? {}),
              [currentField.key]: currentValue,
            };
            if (!rawValue.trim() && currentField.defaultValue) {
              setBrokerFieldValue(selectedBrokerId, currentField.key, currentField.defaultValue);
            }
            if (brokerFieldIdx < activeBrokerFields.length - 1) {
              const nextIndex = brokerFieldIdx + 1;
              const nextField = activeBrokerFields[nextIndex];
              setBrokerFieldIdx(nextIndex);
              setEditingField(nextField?.type !== "select");
            } else {
              void syncSelectedBroker(nextValues);
            }
          }
        }
      } else if (isPlainEscape(event)) {
        setEditingField(false);
        if (step === "account") {
          returnToAccountChooser();
        } else if (portfolioSub === "broker-fields") {
          setPortfolioSub("broker-setup");
        } else {
          setPortfolioSub("choose");
          setBrokerFieldIdx(0);
        }
      }
      return;
    }

    if (event.name === "return" || event.name === "enter") {
      if (step === "ready") {
        finish();
        return;
      }
      if (step === "account") {
        if (accountSubmitting) return;
        if (accountSub === "choose") {
          const choice = ACCOUNT_CHOICE_IDS[accountChoiceIdx];
          if (!choice || choice === "skip") {
            nextStep();
            return;
          }
          beginAccountMode(choice);
          return;
        }
        if (accountSub === "signup" || accountSub === "login") {
          if (accountSubmitError?.kind === "switch-to-login") {
            switchToAccountLogin();
          } else if (accountSubmitError) {
            submitAccount();
          } else {
            setEditingField(true);
          }
          return;
        }
        nextStep();
        return;
      }
      if (step === "portfolio") {
        if (portfolioSub === "choose") {
          const choice = portfolioChoices[portfolioOptionIdx]!;
          if (choice.id === "manual") {
            resetBrokerSync();
            setSelectedBrokerId(null);
            nextStep();
          } else {
            resetBrokerSync();
            setSelectedBrokerId(choice.id);
            setBrokerFieldIdx(0);
            setPortfolioSub("broker-fields");
            const broker = brokerOptions.find((option) => option.id === choice.id);
            const initialField = broker
              ? resolveBrokerConfigFields(broker.adapter, brokerValues[choice.id] ?? {}).filter((field) => field.required)[0]
              : null;
            setEditingField(initialField?.type !== "select");
          }
          return;
        }
        if (portfolioSub === "broker-setup" && selectedBrokerId) {
          setPortfolioSub("broker-fields");
          const currentField = activeBrokerFields[brokerFieldIdx];
          setEditingField(currentField?.type !== "select");
          return;
        }
        if (portfolioSub === "broker-fields" && selectedBrokerId) {
          const currentField = activeBrokerFields[brokerFieldIdx];
          if (!currentField) {
            void syncSelectedBroker();
            return;
          }
          if (currentField.type === "select") {
            const option = currentField.options?.[brokerSelectIdx];
            if (!option) return;
            setBrokerFieldValue(selectedBrokerId, currentField.key, option.value);
            const nextValues = {
              ...(brokerValues[selectedBrokerId] ?? {}),
              [currentField.key]: option.value,
            };
            const broker = brokerOptions.find((entry) => entry.id === selectedBrokerId);
            const fields = broker
              ? resolveBrokerConfigFields(broker.adapter, nextValues).filter((field) => field.required)
              : activeBrokerFields;
            if (brokerFieldIdx < fields.length - 1) {
              const nextIndex = brokerFieldIdx + 1;
              const nextField = fields[nextIndex];
              setBrokerFieldIdx(nextIndex);
              if (currentField.key === "connectionMode") {
                setPortfolioSub("broker-setup");
              } else {
                setEditingField(nextField?.type !== "select");
              }
            } else {
              void syncSelectedBroker(nextValues);
            }
            return;
          }
          if (!editingField) {
            setEditingField(true);
            return;
          }
        }
        if (portfolioSub === "broker-sync") {
          if (!isBrokerSyncing && brokerSyncError) {
            void syncSelectedBroker();
          }
          return;
        }
      }
      nextStep();
    } else if (isBackNavigationKey(event) || event.name === "left") {
      if (step === "account" && (accountSub === "signup" || accountSub === "login")) {
        returnToAccountChooser();
        return;
      }
      if (step === "portfolio" && portfolioSub === "broker-sync") {
        resetBrokerSync();
        setPortfolioSub("broker-fields");
        return;
      }
      if (step === "portfolio" && portfolioSub === "broker-fields") {
        setPortfolioSub("broker-setup");
        return;
      }
      if (step === "portfolio" && portfolioSub === "broker-setup") {
        setPortfolioSub("broker-fields");
        setBrokerFieldIdx(0);
        return;
      }
      if (step === "portfolio" && portfolioSub !== "choose") {
        setPortfolioSub("choose");
        setBrokerFieldIdx(0);
        return;
      }
      prevStep();
    } else if (event.name === "right") {
      nextStep();
    }

    if (step === "theme") {
      if (isPlainKey(event, "up", "k")) {
        setThemeIdx((index) => Math.max(0, index - 1));
      } else if (isPlainKey(event, "down", "j")) {
        setThemeIdx((index) => Math.min(themeIds.length - 1, index + 1));
      }
    } else if (step === "account" && accountSub === "choose") {
      if (isPlainKey(event, "up", "k")) {
        setAccountChoiceIdx((index) => Math.max(0, index - 1));
      } else if (isPlainKey(event, "down", "j")) {
        setAccountChoiceIdx((index) => Math.min(ACCOUNT_CHOICE_IDS.length - 1, index + 1));
      }
    } else if (step === "portfolio" && portfolioSub === "choose") {
      if (isPlainKey(event, "up", "k")) {
        setPortfolioOptionIdx((index) => Math.max(0, index - 1));
      } else if (isPlainKey(event, "down", "j")) {
        setPortfolioOptionIdx((index) => Math.min(portfolioChoices.length - 1, index + 1));
      }
    } else if (step === "portfolio" && portfolioSub === "broker-fields" && selectedBrokerId) {
      const currentField = activeBrokerFields[brokerFieldIdx];
      if (currentField?.type === "select") {
        const optionCount = currentField.options?.length ?? 0;
        if (isPlainKey(event, "up", "k")) {
          setBrokerSelectIdx((index) => Math.max(0, index - 1));
        } else if (isPlainKey(event, "down", "j")) {
          setBrokerSelectIdx((index) => Math.min(optionCount - 1, index + 1));
        }
      }
    }
  }, { allowEditable: true });
}
