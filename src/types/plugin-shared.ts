export interface WizardStep {
  key: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  type?: "text" | "password" | "info" | "select" | "number" | "textarea";
  options?: Array<{ label: string; value: string }>;
  /** Shown only while the earlier answer holds the value; with several, while every one does. */
  dependsOn?: { key: string; value: string } | ReadonlyArray<{ key: string; value: string }>;
  /** Later wizard values to clear when this selection changes from its default. */
  clearOnChange?: string[];
  body?: string[];
}
