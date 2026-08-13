import { useCallback, useRef } from "react";
import { NavLink, useNavigate, useLocation } from "react-router-dom";

const TABS = [
  { path: "/chat", label: "Chat" },
  { path: "/quick", label: "Quick" },
  { path: "/council", label: "Council" },
  { path: "/humanize", label: "Humanizer" },
  { path: "/pr", label: "Code + PR" },
];

export default function ModeTabs() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const tabRefs = useRef([]);

  const handleKeyDown = useCallback(
    (e, idx) => {
      let next = null;
      if (e.key === "ArrowRight") {
        next = (idx + 1) % TABS.length;
      } else if (e.key === "ArrowLeft") {
        next = (idx - 1 + TABS.length) % TABS.length;
      } else if (e.key === "Home") {
        next = 0;
      } else if (e.key === "End") {
        next = TABS.length - 1;
      }
      if (next != null) {
        e.preventDefault();
        tabRefs.current[next]?.focus();
        navigate(TABS[next].path);
      }
    },
    [navigate],
  );

  return (
    <nav aria-label="Mode navigation">
      <div role="tablist" className="mode-tabs" aria-label="Application modes">
        {TABS.map((tab, idx) => (
          <NavLink
            key={tab.path}
            to={tab.path}
            role="tab"
            // A tablist without aria-selected tells a screen reader nothing
            // about which mode is active — the visual class alone is not
            // exposed to assistive technology.
            aria-selected={pathname === tab.path}
            aria-current={pathname === tab.path ? "page" : undefined}
            ref={(el) => (tabRefs.current[idx] = el)}
            className={({ isActive }) => "mode-tab" + (isActive ? " mode-tab--active" : "")}
            onKeyDown={(e) => handleKeyDown(e, idx)}
            tabIndex={0}
          >
            {({ isActive }) => (
              <span data-selected={isActive ? "true" : "false"}>{tab.label}</span>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
