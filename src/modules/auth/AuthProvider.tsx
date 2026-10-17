import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';

import type { Session, SupabaseClient } from '@supabase/supabase-js';

import { getCentrePermissions } from '../../data/repositories/centrePermissionRepository';
import { getAuthProfile } from '../../data/repositories/profileRepository';
import { getSupabaseClient } from '../../data/supabase/client';
import { isPendingStudent } from '../../business/permissions/permissions';
import type { AuthProfile, CentrePermissions } from '../../types/auth';
import { hasPasswordAuthMethod } from './authSession';

export type ActiveCentre = { id: string; name: string };

export type AuthStatus =
  | 'loading'
  | 'anonymous'
  | 'authenticated'
  | 'pending'
  | 'error'
  | 'configuration_error';

type AuthContextValue = {
  status: AuthStatus;
  session: Session | null;
  profile: AuthProfile | null;
  activeCentres: ActiveCentre[];
  activeCentreId: string;
  permissions: CentrePermissions;
  permissionErrors: string[];
  mustChangePassword: boolean;
  error: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  changePassword: (password: string) => Promise<void>;
  setActiveCentreId: (centreId: string | null) => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Une erreur inattendue est survenue.';
}

export function AuthProvider({ children }: PropsWithChildren) {
  const clientRef = useRef<SupabaseClient | null>(null);
  const requestVersion = useRef(0);
  const signOutMessage = useRef<string | null>(null);

  const [status, setStatus] = useState<AuthStatus>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<AuthProfile | null>(null);
  const [activeCentres, setActiveCentres] = useState<ActiveCentre[]>([]);
  const [activeCentreId, setActiveCentreIdState] = useState('');
  const [permissions, setPermissions] = useState<CentrePermissions>({});
  const [permissionErrors, setPermissionErrors] = useState<string[]>([]);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolveSession = useCallback(
    async (client: SupabaseClient, nextSession: Session | null) => {
      const version = ++requestVersion.current;

      if (!nextSession) {
        const pendingMessage = signOutMessage.current;
        signOutMessage.current = null;

        setError(pendingMessage);
        setSession(null);
        setProfile(null);
        setActiveCentres([]);
        setActiveCentreIdState('');
        setPermissions({});
        setPermissionErrors([]);
        setMustChangePassword(false);
        setStatus('anonymous');
        return;
      }

      setError(null);
      setSession(nextSession);
      setProfile(null);
      setPermissions({});
      setPermissionErrors([]);
      setStatus('loading');

      try {
        const databaseProfile = await getAuthProfile(client, nextSession.user.id);

        const storedCentreId =
          databaseProfile.role === 'super_admin'
            ? window.localStorage.getItem('schoolplans_current_centre')
            : null;

        const nextProfile =
          databaseProfile.role === 'super_admin' && storedCentreId
            ? { ...databaseProfile, centreId: storedCentreId }
            : databaseProfile;

        if (
          nextProfile.role === 'admin' &&
          !hasPasswordAuthMethod(nextSession)
        ) {
          const message =
            'Le compte administrateur ne peut pas se connecter avec Google. Utilisez l’e-mail et le mot de passe.';

          signOutMessage.current = message;

          const { error: signOutError } = await client.auth.signOut();

          if (signOutError) {
            signOutMessage.current = null;
            throw signOutError;
          }

          if (version === requestVersion.current) {
            setSession(null);
            setProfile(null);
            setStatus('anonymous');
            setError(message);
          }

          return;
        }

        setError(null);

        let nextActiveCentres: ActiveCentre[] = [];
        let nextActiveCentreId = '';

        if (nextProfile.role === 'super_admin') {
          const { data: centreRows, error: centresError } = await client
            .from('centres')
            .select('id, nom')
            .eq('actif', true)
            .order('nom', { ascending: true });

          if (centresError) throw centresError;

          nextActiveCentres = (centreRows ?? []).flatMap((row) =>
            typeof row.id === 'string' && typeof row.nom === 'string'
              ? [{ id: row.id, name: row.nom }]
              : [],
          );

          const savedCentreId =
            window.localStorage.getItem('schoolplans_current_centre') ?? '';

          nextActiveCentreId = nextActiveCentres.some(
            (centre) => centre.id === savedCentreId,
          )
            ? savedCentreId
            : (nextActiveCentres[0]?.id ?? '');

          if (nextActiveCentreId) {
            window.localStorage.setItem(
              'schoolplans_current_centre',
              nextActiveCentreId,
            );
          } else {
            window.localStorage.removeItem('schoolplans_current_centre');
          }
        }

        const permissionLoad = await getCentrePermissions(
          client,
          nextProfile.role === 'super_admin',
        );

        if (version !== requestVersion.current) return;

        setSession(nextSession);
        setProfile(nextProfile);
        setActiveCentres(nextActiveCentres);
        setActiveCentreIdState(nextActiveCentreId);
        setPermissions(permissionLoad.permissions);
        setPermissionErrors(permissionLoad.failedKeys);
        setMustChangePassword(
          nextSession.user.user_metadata?.must_change === true,
        );
        setStatus(
          isPendingStudent(nextProfile) ? 'pending' : 'authenticated',
        );
      } catch (cause) {
        if (version !== requestVersion.current) return;

        signOutMessage.current = null;
        setError(errorMessage(cause));
        setStatus('error');
      }
    },
    [],
  );

  useEffect(() => {
    let active = true;
    let client: SupabaseClient;

    try {
      client = getSupabaseClient();
      clientRef.current = client;
    } catch (cause) {
      setError(errorMessage(cause));
      setStatus('configuration_error');

      return () => {
        active = false;
      };
    }

    const { data } = client.auth.onAuthStateChange(
      (_event, nextSession) => {
        window.setTimeout(() => {
          if (active) {
            void resolveSession(client, nextSession);
          }
        }, 0);
      },
    );

    return () => {
      active = false;
      requestVersion.current += 1;
      data.subscription.unsubscribe();
      clientRef.current = null;
    };
  }, [resolveSession]);

  const requireClient = useCallback(() => {
    if (!clientRef.current) {
      throw new Error(
        'Supabase n’est pas configuré. Renseignez les variables VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY.',
      );
    }

    return clientRef.current;
  }, []);

  const setActiveCentreId = useCallback(
    (centreId: string | null) => {
      if (
        centreId &&
        !activeCentres.some((centre) => centre.id === centreId)
      ) {
        return;
      }

      if (centreId) {
        window.localStorage.setItem(
          'schoolplans_current_centre',
          centreId,
        );
      } else {
        window.localStorage.removeItem('schoolplans_current_centre');
      }

      setActiveCentreIdState(centreId ?? '');

      setProfile((current) => {
        if (
          !current ||
          current.role !== 'super_admin' ||
          current.centreId === centreId
        ) {
          return current;
        }

        return { ...current, centreId };
      });
    },
    [activeCentres],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      const { error: authError } =
        await requireClient().auth.signInWithPassword({
          email: email.trim(),
          password,
        });

      if (authError) throw authError;
    },
    [requireClient],
  );

  const signUp = useCallback(
    async (email: string, password: string) => {
      const { error: authError } = await requireClient().auth.signUp({
        email: email.trim(),
        password,
        options: {
          emailRedirectTo: `${window.location.origin}${window.location.pathname}`,
        },
      });

      if (authError) throw authError;
    },
    [requireClient],
  );

  const signInWithGoogle = useCallback(async () => {
    const { error: authError } =
      await requireClient().auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}${window.location.pathname}`,
          queryParams: { prompt: 'select_account' },
        },
      });

    if (authError) throw authError;
  }, [requireClient]);

  const signOut = useCallback(async () => {
    signOutMessage.current = null;
    setError(null);

    const { error: authError } = await requireClient().auth.signOut();

    if (authError) setError(authError.message);
  }, [requireClient]);

  const changePassword = useCallback(
    async (password: string) => {
      const client = requireClient();

      const { error: updateError } = await client.auth.updateUser({
        password,
        data: { must_change: false },
      });

      if (updateError) throw updateError;

      setMustChangePassword(false);
    },
    [requireClient],
  );

  const exposedProfile =
    profile && profile.role === 'super_admin'
      ? { ...profile, centreId: activeCentreId || null }
      : profile;

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      session,
      profile: exposedProfile,
      activeCentres,
      activeCentreId,
      permissions,
      permissionErrors,
      mustChangePassword,
      error,
      signIn,
      signUp,
      signInWithGoogle,
      signOut,
      changePassword,
      setActiveCentreId,
    }),
    [
      status,
      session,
      exposedProfile,
      activeCentres,
      activeCentreId,
      permissions,
      permissionErrors,
      mustChangePassword,
      error,
      signIn,
      signUp,
      signInWithGoogle,
      signOut,
      changePassword,
      setActiveCentreId,
    ],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used inside AuthProvider.');
  }

  return context;
}