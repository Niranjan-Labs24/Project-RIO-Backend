export interface StudyConfigOption {
  id: string;
  name: string;
  displayOrder: number;
  isActive: boolean;
}

export interface StudyConfigOptionRow {
  id: string;
  name: string;
  displayOrder: number;
  isActive: boolean;
}

export interface CreateStudyConfigOptionPayload {
  name: string;
  displayOrder?: number;
}

export interface UpdateStudyConfigOptionPayload {
  name?: string;
  displayOrder?: number;
}
