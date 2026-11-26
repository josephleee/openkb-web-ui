import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { getAuthSession, logout } from "../api/auth";
import { onUnauthorized } from "../api/http";
import { AuthContext, type AuthState } from "../lib/authContext";
import LoginScreen from "./LoginScreen";

type Phase = "checking" | "signed-out" | "ready";

/**
 * Shows the sign-in screen instead of the app when the server has an access
 * token configured and this browser has no valid session: on load (asks
 * /api/auth/session once) and whenever any API call answers 401 later.
 * Without a token on the server it renders the app unchanged.
 */
export default function AuthGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>("checking");
  const [authRequired, setAuthRequired] = useState(false);

  useEffect(() => {
    let active = true;
    const unsubscribe = onUnauthorized(() => {
      if (!active) return;
      setAuthRequired(true);
      setPhase("signed-out");
    });
    getAuthSession().then(
      (session) => {
        if (!active) return;
        setAuthRequired(session.auth_required);
        setPhase(session.auth_required && !session.authenticated ? "signed-out" : "ready");
      },
      () => {
        // Backend unreachable (or too old to know this endpoint): render the
        // app, whose own error states cover it, exactly as before.
        if (active) setPhase((current) => (current === "checking" ? "ready" : current));
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // Drop cached knowledge-base data once the app is unmounted on sign-out, so
  // nothing from the old session lingers or flashes after the next sign-in.
  useEffect(() => {
    if (phase === "signed-out") queryClient.clear();
  }, [phase, queryClient]);

  const signOut = useCallback(async () => {
    try {
      await logout();
    } catch {
      // Sign out locally even if the server could not be reached.
    }
    setPhase("signed-out");
  }, []);

  const value = useMemo<AuthState>(() => ({ authRequired, signOut }), [authRequired, signOut]);

  if (phase === "checking") return <div className="h-full bg-bg" aria-busy="true" />;
  if (phase === "signed-out") {
    return (
      <LoginScreen
        onSignedIn={() => {
          setAuthRequired(true);
          setPhase("ready");
        }}
      />
    );
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
