export const SOURCE_ROLES = ['admin', 'director', 'super_admin', 'formateur', 'etudiant'] as const;

export type SourceRole = (typeof SOURCE_ROLES)[number];

export type AuthProfile = {
  id: string;
  fullName: string;
  role: SourceRole;
  status: string | null;
  centreId: string | null;
};

export const LOADED_CENTRE_PERMISSION_KEYS = [
  'etudiants',
  'formateurs',
  'cours',
  'planning',
  'salles',
  'presences',
  'certificats',
  'supports',
  'documents',
  'statistiques',
  'rapports',
  'import_excel',
  'export_excel',
  'seances',
  'formations',
  'groupes',
] as const;

export type LoadedCentrePermissionKey = (typeof LOADED_CENTRE_PERMISSION_KEYS)[number];
export type CentrePermissionKey = LoadedCentrePermissionKey;

export type CentrePermissions = Partial<Record<CentrePermissionKey, boolean>>;

export const APP_SECTIONS = [
  'vcal',
  'vd',
  'vrapport',
  'vl',
  'vr',
  'vk',
  'vm',
  'vq',
  'vf',
  'vp',
  'vn',
  'vi',
  'vs',
  'vfg',
  'vc',
  'vh',
  'vpcentre',
  'vz',
] as const;

export type AppSection = (typeof APP_SECTIONS)[number];
