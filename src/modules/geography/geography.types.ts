export interface RegionRow {
  id: string;
  code: number;
  name: string;
  isoCode: string;
  capital: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface GovernorateRow {
  id: string;
  code: string;
  regionId: string;
  name: string;
  category: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CenterRow {
  id: string;
  code: string;
  governorateId: string;
  name: string;
  category: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Region {
  id: string;
  code: number;
  name: string;
  isoCode: string;
  capital: string;
}

export interface Governorate {
  id: string;
  code: string;
  regionId: string;
  name: string;
  category: string;
}

export interface Center {
  id: string;
  code: string;
  governorateId: string;
  name: string;
  category: string;
}
