import type { StudentIdentifier } from './students';

export type PlanningCourse = {
  id: StudentIdentifier;
  subjectId: StudentIdentifier;
  teacherId: StudentIdentifier;
  roomId: StudentIdentifier | null;
  groupId: StudentIdentifier | null;
  weekday: number;
  startsAt: string;
  endsAt: string;
  startsOn: string | null;
  endsOn: string | null;
  subjectName: string;
  domainName: string | null;
  teacherName: string;
  roomName: string | null;
  groupName: string | null;
  formationId: StudentIdentifier | null;
};

export type PlanningGroup = {
  id: StudentIdentifier;
  name: string;
  formationId: StudentIdentifier | null;
  formationName: string | null;
  teacherId: StudentIdentifier | null;
  capacity: number;
  active: boolean;
  startsOn: string | null;
  endsOn: string | null;
};

export type PlanningRoom = {
  id: StudentIdentifier;
  name: string;
  type: string | null;
  capacity: number | null;
};

export type PlanningFilterOptions = {
  formations: Array<{
    id: StudentIdentifier;
    name: string;
    totalHours: number | string | null;
    duration: string | null;
    hoursPerWeek: number | string | null;
    description: string | null;
    active: boolean;
  }>;
  groups: PlanningGroup[];
  subjects: Array<{
    id: StudentIdentifier;
    name: string;
    domainName: string | null;
  }>;
  teachers: Array<{
    id: StudentIdentifier;
    name: string;
    email: string | null;
    profileId: string | null;
  }>;
  rooms: PlanningRoom[];
};

export type PlanningData = {
  courses: PlanningCourse[];
  filters: PlanningFilterOptions;
  subjectIdsByFormation: Record<string, StudentIdentifier[]>;
  subjectIdsByTeacher: Record<string, StudentIdentifier[]>;
  closedDates: Record<string, string>;
  cancelledOccurrences: Set<string>;
  completedOccurrences: Set<string>;
  pendingOccurrences: Set<string>;
  rejectedOccurrences: Set<string>;
  rejectionReasonsByOccurrence: Record<string, string>;
};

export type PlanningFilters = {
  formationId: string;
  groupId: string;
  subjectId: string;
  teacherId: string;
};

export type PlanningOccurrence = PlanningCourse & {
  date: string;
  startsAtMinutes: number;
  endsAtMinutes: number;
  cancelled: boolean;
  completed: boolean;
  validationStatus: 'none' | 'pending' | 'approved' | 'rejected';
  rejectionReason: string | null;
};

export type PlanningCourseInput = {
  courseId?: StudentIdentifier;
  groupId: StudentIdentifier;
  subjectId: StudentIdentifier;
  date: string;
  startsAt: string;
  endsAt: string;
  roomId: StudentIdentifier | null;
  teacherId: StudentIdentifier | null;
  recurring: boolean;
};
