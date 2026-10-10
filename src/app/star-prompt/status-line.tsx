import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Span, Text, useActionShortcut, useRendererHost } from "../../ui";
import { Button } from "../../components/ui/button";
import {
  STATUS_WIDGET_COLUMNS,
  useStatusWidgetClaim,
  useStatusWidgetRoom,
} from "../../components/layout/status-widget-space";
import { t } from "../../i18n";
import { useAppLanguage } from "../../i18n/react";
import { useAppActive } from "../../state/app/activity";
import { useAppDispatch, useAppGetState, useAppSelector } from "../../state/app/context";
import { scheduleConfigSave } from "../../state/config-save-scheduler";
import { useThemeColors } from "../../theme/theme-context";
import type { StarPromptConfig } from "../../types/config";
import { displayWidth } from "../../utils/format";
import {
  finishStarPrompt,
  isStarPromptDue,
  localDayKey,
  markStarPromptShown,
  recordStarPromptDay,
  STAR_PROMPT_DELAY_MS,
  STAR_PROMPT_REPO_URL,
  STAR_PROMPT_VISIBLE_MS,
} from "./model";
import { bindStarPromptKeys, isStarPromptAllowed } from "./runtime";

/** A session left open past midnight counts the new day too. */
const DAY_CHECK_INTERVAL_MS = 10 * 60_000;
const STAR = "★ ";
/** Between the star action and the dismiss one. */
const GAP = "  ";

interface StarPromptCopy {
  lead: string;
  columns: number;
}

/**
 * The longest lead the status bar has room for beside its other widgets, or
 * null when not even the short one fits; the line then waits for a wider
 * terminal rather than show cut off.
 */
function starPromptCopy(widgetRoom: number, openKey: string, dismissKey: string): StarPromptCopy | null {
  const spare = widgetRoom - STATUS_WIDGET_COLUMNS;
  const keys = (openKey ? 1 + displayWidth(openKey) : 0)
    + GAP.length
    + 1 + (dismissKey ? 1 + displayWidth(dismissKey) : 0)
    // The chip padding after the line.
    + 1;
  for (const lead of [t("Enjoying Gloomberb? Star it on GitHub"), t("Star on GitHub")]) {
    const columns = displayWidth(STAR + lead) + keys;
    if (spare >= columns) return { lead, columns };
  }
  return null;
}

type Phase = "waiting" | "showing" | "done";

interface StarPromptStatusLineProps {
  delayMs?: number;
  visibleMs?: number;
}

/**
 * One line in the terminal's status bar, once, asking to star the repository:
 * the notification action key opens it in the browser, the dismiss key or the
 * × hides it, and it times out on its own. It never takes focus and sits in
 * the status bar's own row, so it covers nothing. See `./model.ts` for when.
 */
export function StarPromptStatusLine(props: StarPromptStatusLineProps) {
  if (!isStarPromptAllowed()) return null;
  return <StarPromptLine {...props} />;
}

function StarPromptLine({ delayMs = STAR_PROMPT_DELAY_MS, visibleMs = STAR_PROMPT_VISIBLE_MS }: StarPromptStatusLineProps) {
  useAppLanguage();
  const colors = useThemeColors();
  const dispatch = useAppDispatch();
  const getState = useAppGetState();
  const rendererHost = useRendererHost();
  const onScreen = useAppActive();
  const widgetRoom = useStatusWidgetRoom();
  const openKey = useActionShortcut("notification-action");
  const dismissKey = useActionShortcut("notification-dismiss");
  const starPrompt = useAppSelector((state) => state.config.starPrompt);
  // Days of use count from the first one past setup.
  const onboarded = useAppSelector((state) => state.config.onboardingComplete === true && !state.config.onboardingProgress);
  const [phase, setPhase] = useState<Phase>("waiting");
  const waitedMs = useRef(0);
  const shownMs = useRef(0);
  const copy = starPromptCopy(widgetRoom, openKey, dismissKey);
  const fits = copy !== null;
  const due = isStarPromptDue(starPrompt);

  const update = useCallback((change: (state: StarPromptConfig | undefined) => StarPromptConfig | undefined) => {
    const current = getState().config.starPrompt;
    const next = change(current);
    if (next === current) return;
    dispatch({ type: "SET_STAR_PROMPT", starPrompt: next });
    // Assembled when the write fires, recent tickers included, as the app's own saves are.
    scheduleConfigSave(() => {
      const state = getState();
      return { ...state.config, recentTickers: state.recentTickers };
    });
  }, [dispatch, getState]);

  useEffect(() => {
    if (!onboarded) return;
    const record = () => update((state) => recordStarPromptDay(state, localDayKey(new Date())));
    record();
    const timer = setInterval(record, DAY_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [onboarded, update]);

  // Counts only time on screen with room for the line, so it never shows to
  // a terminal in the background or too narrow to read it.
  useEffect(() => {
    if (phase !== "waiting" || !due || !onScreen || !fits) return;
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      if (!isStarPromptDue(getState().config.starPrompt)) {
        setPhase("done");
        return;
      }
      // Recorded as it appears, so quitting while it shows also ends it.
      update((state) => markStarPromptShown(state, new Date()));
      setPhase("showing");
    }, Math.max(0, delayMs - waitedMs.current));
    return () => {
      clearTimeout(timer);
      waitedMs.current += Date.now() - startedAt;
    };
  }, [delayMs, due, fits, getState, onScreen, phase, update]);

  const finish = useCallback((outcome: NonNullable<StarPromptConfig["outcome"]>) => {
    update((state) => finishStarPrompt(state, outcome));
    setPhase("done");
  }, [update]);
  const open = useCallback(() => {
    void rendererHost.openExternal(STAR_PROMPT_REPO_URL);
    finish("opened");
  }, [finish, rendererHost]);
  const dismiss = useCallback(() => finish("dismissed"), [finish]);

  useEffect(() => {
    if (phase !== "showing" || !onScreen) return;
    const startedAt = Date.now();
    const timer = setTimeout(() => finish("expired"), Math.max(0, visibleMs - shownMs.current));
    return () => {
      clearTimeout(timer);
      shownMs.current += Date.now() - startedAt;
    };
  }, [finish, onScreen, phase, visibleMs]);

  const showing = phase === "showing" && fits;
  useEffect(() => (showing ? bindStarPromptKeys({ open, dismiss }) : undefined), [dismiss, open, showing]);
  // The version chip gives way to the line.
  useStatusWidgetClaim("star-prompt", showing && copy ? copy.columns : 0);

  if (!showing || !copy) return null;
  return (
    <Box flexDirection="row" flexShrink={0} paddingRight={1} data-gloom-role="star-prompt">
      <Button
        label={t("Star Gloomberb on GitHub")}
        variant="plain"
        compact
        shortcut={openKey || undefined}
        stopPropagation
        onPress={open}
      >
        <Text fg={colors.text}>
          <Span fg={colors.warning}>{STAR}</Span>
          {copy.lead}
        </Text>
      </Button>
      <Text>{GAP}</Text>
      <Button
        label={t("Dismiss")}
        displayLabel="×"
        variant="plain"
        compact
        shortcut={dismissKey || undefined}
        stopPropagation
        onPress={dismiss}
      />
    </Box>
  );
}
