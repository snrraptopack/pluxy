export interface CourseSheet {
  studentResultSheetId: number;
  classScore: number;
  examScore: number;
  fullScore: number;
  specialCase: string | null;
  credit: number;
  courseName: string;
  code: string;
  hasTrailed: boolean;
  hasPassed: boolean;
  letter: string;
  descriptions: string;
}

export interface SemesterResult {
  studentResultId: number;
  academicYear: string;
  year: number;
  semester: number;
  semesterAverage: number;
  cwa: number;
  semesterWeightedMark: number;
  cumulativeSemesterMark: number;
  creditRegistered: number;
  cumulativeCreditRegistered: number;
  creditEarned: number;
  cumulativeCreditEarned: number;
  sheets: CourseSheet[];
}

export interface UmatResultsResponse {
  isSuccessful: boolean;
  message: string;
  data: SemesterResult[];
  studentName: string;
  updated?: number;
}
