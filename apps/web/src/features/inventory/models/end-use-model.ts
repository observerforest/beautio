import {
  isoDateSchema,
  type EndInventoryItemInput,
} from "@beautio/contracts";

export type EndUseTargetLifecycle = "finished" | "discarded";
export type RemainingSelection = "unset" | "estimate" | "unknown";

export interface EndUseDraft {
  readonly lifecycleStatus: EndUseTargetLifecycle | null;
  readonly remainingSelection: RemainingSelection;
  readonly remainingPercent: number;
}

export type EndUseDraftField = "lifecycle" | "remaining";

export type EndUseBuildResult =
  | { readonly ok: true; readonly input: EndInventoryItemInput }
  | {
      readonly ok: false;
      readonly field: EndUseDraftField;
      readonly message: string;
    };

export const endUseQuickPercentages = [0, 25, 50, 75, 100] as const;

/**
 * Creates an end-use draft with no persisted assumption about target lifecycle or remaining amount.
 *
 * @returns A draft whose 50% thumb position is only a neutral visual starting point;
 * it is not submitted until the user explicitly moves the slider or selects a value.
 */
export function emptyEndUseDraft(): EndUseDraft {
  return {
    lifecycleStatus: null,
    remainingSelection: "unset",
    remainingPercent: 50,
  };
}

/**
 * Converts one explicitly completed end-use draft to the strict public command.
 *
 * @param draft - User-selected terminal lifecycle and remaining-amount state.
 * @param asOf - Explicit local YYYY-MM-DD date used for the server readback.
 * @returns A finished command without a client-supplied remaining field, a discarded
 * command with a known or explicitly unknown estimate, or a focused validation error.
 */
export function buildEndUseInput(
  draft: EndUseDraft,
  asOf: string,
): EndUseBuildResult {
  const parsedAsOf = isoDateSchema.safeParse(asOf);
  if (!parsedAsOf.success) {
    return {
      ok: false,
      field: "lifecycle",
      message: "当前日期无效，请刷新页面后再试。",
    };
  }
  if (draft.lifecycleStatus === null) {
    return { ok: false, field: "lifecycle", message: "请选择用完或丢弃。" };
  }
  if (draft.lifecycleStatus === "finished") {
    return {
      ok: true,
      input: { as_of: parsedAsOf.data, lifecycle_status: "finished" },
    };
  }
  if (draft.remainingSelection === "unset") {
    return {
      ok: false,
      field: "remaining",
      message: "请估算剩余量，或明确选择未知。",
    };
  }
  if (draft.remainingSelection === "unknown") {
    return {
      ok: true,
      input: {
        as_of: parsedAsOf.data,
        lifecycle_status: "discarded",
        remaining_percent_estimate: null,
      },
    };
  }
  if (
    !Number.isInteger(draft.remainingPercent) ||
    draft.remainingPercent < 0 ||
    draft.remainingPercent > 100
  ) {
    return {
      ok: false,
      field: "remaining",
      message: "剩余量必须是 0–100 的整数，或明确选择未知。",
    };
  }
  return {
    ok: true,
    input: {
      as_of: parsedAsOf.data,
      lifecycle_status: "discarded",
      remaining_percent_estimate: draft.remainingPercent,
    },
  };
}
