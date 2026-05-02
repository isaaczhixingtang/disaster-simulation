"use client";

import { useEffect } from "react";

export function SimulatorEngine() {
  useEffect(() => {
    let cancelled = false;

    import("../legacy/simulator-engine").then(({ startSimulator }) => {
      if (!cancelled) startSimulator();
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return <div id="simulator-canvas-root" aria-hidden="true" />;
}
