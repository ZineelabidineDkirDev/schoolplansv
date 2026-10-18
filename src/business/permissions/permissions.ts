import {
  APP_SECTIONS,
  type AppSection,
  type AuthProfile,
  type CentrePermissionKey,
  type CentrePermissions,
  type SourceRole,
} from '../../types/auth';

const COMMON_SECTIONS: readonly AppSection[] = ['vcal', 'vr'];

const ROLE_SECTIONS: Record<SourceRole, readonly AppSection[]> = {
  admin: [
    ...COMMON_SECTIONS,
    'vf',
    'vd',
    'vh',
    'vl',
    'vk',
    'vpcentre',
    'vp',
    'vi',
    'vs',
    'vfg',
    'vc',
  ],
  director: [
    ...COMMON_SECTIONS,
    'vf',
    'vd',
    'vh',
    'vl',
    'vk',
    'vpcentre',
    'vp',
    'vi',
    'vs',
    'vfg',
    'vc',
  ],
  super_admin: [...COMMON_SECTIONS, 'vz', 'vd'],
  formateur: [...COMMON_SECTIONS, 'vl', 'vn', 'vp', 'vk', 'vrapport'],
  etudiant: ['vcal', 'vr', 'vm', 'vq', 'vk'],
};

const SECTION_REQUIREMENTS: Partial<Record<AppSection, readonly CentrePermissionKey[]>> = {
  vcal: ['planning'],
  vd: ['statistiques'],
  vl: ['cours'],
  vr: ['salles'],
  vk: ['supports', 'documents'],
  vf: ['formateurs'],
  vp: ['presences'],
  vs: ['etudiants'],
  vfg: ['formations'],
  vc: ['certificats'],
};

export const SECTION_LABELS: Record<AppSection, string> = {
  vcal: 'Planning',
  vd: 'Tableau de bord',
  vrapport: 'Rapport du centre',
  vl: 'Séances',
  vr: 'Salles',
  vk: 'Supports',
  vm: 'Mes cours',
  vq: 'Mes présences',
  vf: 'Formateurs',
  vp: 'Présences',
  vn: 'Mes étudiants',
  vi: 'Inscriptions',
  vs: 'Étudiants',
  vfg: 'Formations & Groupes',
  vc: 'Certificats',
  vh: 'Historique',
  vpcentre: 'Profil du centre',
  vz: 'Gérer les centres',
};

export function getRoleLabel(role: SourceRole): string {
  if (role === 'admin' || role === 'director' || role === 'super_admin') {
    return 'Admin';
  }
  return role === 'formateur' ? 'Formateur' : 'Étudiant';
}

export function getVisibleSections(role: SourceRole, permissions: CentrePermissions): AppSection[] {
  return ROLE_SECTIONS[role].filter((section) => canAccessSection(role, section, permissions));
}

export function canAccessSection(
  role: SourceRole,
  section: string,
  permissions: CentrePermissions,
): section is AppSection {
  if (!APP_SECTIONS.includes(section as AppSection)) return false;
  const appSection = section as AppSection;
  if (role === 'super_admin') return true;

  // Les étudiants peuvent toujours consulter leur planning et leurs salles.
  // Ces deux rubriques restent en lecture seule et ne dépendent pas des droits administratifs du centre.
  if (role === 'etudiant' && (appSection === 'vcal' || appSection === 'vr')) return true;

  if (!ROLE_SECTIONS[role].includes(appSection)) return false;
  if (role === 'etudiant' && appSection === 'vk') return true;
  if (role === 'formateur' && appSection === 'vp') return true;

  return (SECTION_REQUIREMENTS[appSection] ?? []).every((key) => permissions[key] === true);
}

export function isPendingStudent(profile: AuthProfile): boolean {
  return profile.role === 'etudiant' && profile.status === 'en_attente';
}
