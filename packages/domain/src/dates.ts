import { BeautioError } from "./errors.ts";

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export type IsoDate = string & { readonly __isoDate: unique symbol };

export type IsoInstant = string & { readonly __isoInstant: unique symbol };

/**
 * Returns whether a string is a real Gregorian calendar date in YYYY-MM-DD form.
 *
 * @param value - Candidate date text.
 * @returns True only for a lexically and calendrically valid date.
 */
export function isIsoDateString(value: string): value is IsoDate {
  const match = ISO_DATE_PATTERN.exec(value);
  if (match === null) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (year < 1 || month < 1 || month > 12 || day < 1) {
    return false;
  }

  return day <= daysInMonth(year, month);
}

/**
 * Parses a YYYY-MM-DD value or raises the stable INVALID_INPUT error.
 *
 * @param value - Candidate date text.
 * @param fieldName - Contract field name included in an error message.
 * @returns The validated date value.
 */
export function parseIsoDate(value: string, fieldName: string): IsoDate {
  if (!isIsoDateString(value)) {
    throw new BeautioError(
      "INVALID_INPUT",
      `${fieldName} must be a real calendar date in YYYY-MM-DD format`,
    );
  }

  return value;
}

/**
 * Adds whole calendar months and clamps an unavailable target day to month end.
 *
 * @param date - Valid source calendar date.
 * @param months - Positive whole-month PAO duration.
 * @returns The derived deadline date.
 */
export function addCalendarMonthsClamped(
  date: IsoDate,
  months: number,
): IsoDate {
  if (!Number.isInteger(months) || months < 1 || months > 120) {
    throw new BeautioError(
      "INVALID_INPUT",
      "pao_duration_months must be an integer from 1 through 120",
    );
  }

  const [yearText, monthText, dayText] = date.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const absoluteMonth = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(absoluteMonth / 12);
  const targetMonth = (absoluteMonth % 12) + 1;
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));

  return formatIsoDate(targetYear, targetMonth, targetDay);
}

export function parseNullableDate(
  value: string | null | undefined,
  fieldName: string,
): IsoDate | null {
  return value === null || value === undefined
    ? null
    : parseIsoDate(value, fieldName);
}

/**
 * Parses a canonical UTC timestamp produced by `Date#toISOString`.
 *
 * @param value - Candidate timestamp or an explicit missing value.
 * @param fieldName - Contract field name included in an error message.
 * @returns The canonical UTC timestamp, or null when the value is missing.
 */
export function parseNullableIsoInstant(
  value: string | null | undefined,
  fieldName: string,
): IsoInstant | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new BeautioError(
      "INVALID_INPUT",
      `${fieldName} must be a canonical UTC timestamp`,
    );
  }
  return value as IsoInstant;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return isLeapYear ? 29 : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function formatIsoDate(year: number, month: number, day: number): IsoDate {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` as IsoDate;
}
