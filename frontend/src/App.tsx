import { Suspense, lazy } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import AppLayout from "./components/AppLayout";
import { PageLoading } from "./components/States";
import ChatPage from "./pages/Chat";
import Dashboard from "./pages/Dashboard";
import DocumentsPage from "./pages/Documents";
import WikiPage from "./pages/Wiki";

// react-force-graph-2d pulls in the d3-force stack; keep it out of the main chunk.
const GraphPage = lazy(() => import("./pages/Graph"));

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/wiki" element={<WikiPage />} />
          <Route path="/wiki/*" element={<WikiPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/:sessionId" element={<ChatPage />} />
          <Route path="/documents" element={<DocumentsPage />} />
          <Route
            path="/graph"
            element={
              <Suspense fallback={<PageLoading />}>
                <GraphPage />
              </Suspense>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
