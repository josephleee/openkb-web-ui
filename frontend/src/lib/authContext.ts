import { createContext, useContext } from "react";

export interface AuthState {
  /** The server has an access token configured (so signing out makes sense). */
  authRequired: boolean;
  /** End the session on the server and return to the sign-in screen. */
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthState>({
  authRequired: false,
  signOut: async () => {},
});

export const useAuth = (): AuthState => useContext(AuthContext);
