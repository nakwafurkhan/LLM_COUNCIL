import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
/* Components used in JSX — react/jsx-uses-vars not available without the plugin */

import ModeTabs from "./components/ModeTabs.jsx";
import ChatRoute from "./routes/ChatRoute.jsx";
import CouncilRoute from "./routes/CouncilRoute.jsx";
import PrRoute from "./routes/PrRoute.jsx";

function FocusManager() {
  const location = useLocation();
  useEffect(() => {
    const main = document.getElementById("main-content");
    if (main) main.focus();
  }, [location.pathname]);
  return null;
}

function Layout({ children }) {
  return (
    <div className="app-layout">
      <header className="app-header">
        <span className="app-logo">LLM Council</span>
        <ModeTabs />
      </header>
      <main id="main-content" tabIndex={-1} className="app-main">
        {children}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <FocusManager />
      <Layout>
        <Routes>
          <Route path="/" element={<Navigate to="/chat" replace />} />
          <Route path="/chat" element={<ChatRoute mode="chat" />} />
          <Route path="/quick" element={<ChatRoute mode="quick" />} />
          <Route path="/council" element={<CouncilRoute />} />
          <Route path="/pr" element={<PrRoute />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
