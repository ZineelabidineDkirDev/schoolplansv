import type {
  PlanningCourse,
  PlanningFilters,
  PlanningGroup,
  PlanningOccurrence,
} from '../../types/planning';

const DAYS_PER_WEEK = 6;
const OPENING_MINUTES = 8 * 60;
const CLOSING_MINUTES = 19 * 60;

export function toDateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

export function getMonday(date: Date): Date {
  const monday = new Date(date);
  monday.setHours(12, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function parseTimeMinutes(value: string): number {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (!match) throw new Error(`Heure de séance invalide : ${value}`);

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error(`Heure de séance invalide : ${value}`);

  return hours * 60 + minutes;
}

function getCourseGroup(course: PlanningCourse, groups: PlanningGroup[]) {
  return groups.find((group) => String(group.id) === String(course.groupId));
}

export function matchesPlanningFilters(
  course: PlanningCourse,
  groups: PlanningGroup[],
  filters: PlanningFilters,
  occurrenceDate?: string,
): boolean {
  if (filters.formationId && String(course.formationId) !== filters.formationId) return false;
  if (filters.groupId && String(course.groupId) !== filters.groupId) return false;
  if (filters.subjectId && String(course.subjectId) !== filters.subjectId) return false;
  if (filters.teacherId && String(course.teacherId) !== filters.teacherId) return false;

  const group = getCourseGroup(course, groups);
  if (group?.startsOn && occurrenceDate && occurrenceDate < group.startsOn) return false;
  if (group?.endsOn && occurrenceDate && occurrenceDate > group.endsOn) return false;
  return true;
}

export function getWeekOccurrences(
  courses: PlanningCourse[],
  weekOf: Date,
  closedDates: Record<string, string>,
  cancelledOccurrences: Set<string>,
  completedOccurrences: Set<string>,
  pendingOccurrences: Set<string> = new Set(),
  rejectedOccurrences: Set<string> = new Set(),
  rejectionReasonsByOccurrence: Record<string, string> = {},
): PlanningOccurrence[] {
  const monday = getMonday(weekOf);
  const occurrences: PlanningOccurrence[] = [];

  for (const course of courses) {
    if (
      !Number.isInteger(course.weekday) ||
      course.weekday < 0 ||
      course.weekday >= DAYS_PER_WEEK
    ) {
      continue;
    }

    const date = toDateKey(addDays(monday, course.weekday));
    if ((course.startsOn && date < course.startsOn) || (course.endsOn && date > course.endsOn)) {
      continue;
    }
    if (closedDates[date]) continue;

    const key = `${course.id}|${date}`;
    occurrences.push({
      ...course,
      date,
      startsAtMinutes: parseTimeMinutes(course.startsAt),
      endsAtMinutes: parseTimeMinutes(course.endsAt),
      cancelled: cancelledOccurrences.has(key),
      completed: completedOccurrences.has(key),
      validationStatus: completedOccurrences.has(key) ? 'approved' : pendingOccurrences.has(key) ? 'pending' : rejectedOccurrences.has(key) ? 'rejected' : 'none',
      rejectionReason: rejectionReasonsByOccurrence[key] ?? null,
    });
  }

  return occurrences.sort(
    (left, right) =>
      left.weekday - right.weekday ||
      left.startsAtMinutes - right.startsAtMinutes ||
      left.subjectName.localeCompare(right.subjectName, 'fr'),
  );
}

export function getRoomAvailability(
  occurrences: PlanningOccurrence[],
  roomId: string,
  weekday: number,
): string[] {
  const occupied = occurrences
    .filter(
      (occurrence) =>
        !occurrence.cancelled &&
        occurrence.weekday === weekday &&
        String(occurrence.roomId) === roomId,
    )
    .sort((left, right) => left.startsAtMinutes - right.startsAtMinutes);

  const freeSlots: string[] = [];
  let nextAvailable = OPENING_MINUTES;
  for (const occurrence of occupied) {
    if (occurrence.startsAtMinutes > nextAvailable) {
      freeSlots.push(`${formatTime(nextAvailable)}–${formatTime(occurrence.startsAtMinutes)}`);
    }
    nextAvailable = Math.max(nextAvailable, occurrence.endsAtMinutes);
  }
  if (nextAvailable < CLOSING_MINUTES) {
    freeSlots.push(`${formatTime(nextAvailable)}–${formatTime(CLOSING_MINUTES)}`);
  }
  return freeSlots;
}

export function formatTime(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
