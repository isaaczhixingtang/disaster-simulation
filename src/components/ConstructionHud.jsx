const hudStyle = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  background: "rgba(20,14,8,0.82)",
  backdropFilter: "blur(4px)",
  padding: "10px 18px",
  display: "flex",
  alignItems: "center",
  gap: "16px",
  zIndex: 200,
  fontFamily: "sans-serif",
  color: "#f5e6c8",
};

const buttonRowStyle = {
  marginLeft: "auto",
  display: "flex",
  gap: "10px",
};

const buttonStyle = {
  color: "#fff",
  border: "none",
  padding: "6px 14px",
  borderRadius: "6px",
  cursor: "pointer",
  fontSize: "0.9rem",
};

const tourOverlayStyle = {
  display: "none",
  position: "fixed",
  bottom: "20px",
  left: "50%",
  transform: "translateX(-50%)",
  background: "rgba(10,5,30,0.85)",
  backdropFilter: "blur(8px)",
  border: "1px solid rgba(124,58,237,0.5)",
  borderRadius: "12px",
  padding: "12px 24px",
  color: "#fff",
  fontFamily: "sans-serif",
  zIndex: 300,
  textAlign: "center",
};

export function ConstructionHud() {
  return (
    <div id="construction-hud" className="hidden">
      <div style={hudStyle}>
        <span style={{ fontSize: "1.1rem", fontWeight: 700 }}>🏗️ Construction Sim</span>
        <span id="constr-status" style={{ fontSize: "0.95rem", color: "#fbbf24" }}>
          Preparing site...
        </span>
        <div style={buttonRowStyle}>
          <button id="btn-constr-add" style={{ ...buttonStyle, background: "#16a34a" }}>
            + Add Building
          </button>
          <button id="btn-constr-speed" style={{ ...buttonStyle, background: "#0369a1" }}>
            ⏩ 2× Speed
          </button>
          <button
            id="btn-constr-tour"
            style={{ ...buttonStyle, background: "#7c3aed", display: "none" }}
          >
            🎬 Tour
          </button>
          <button id="constr-exit" style={{ ...buttonStyle, background: "#7f1d1d" }}>
            🚪 Exit
          </button>
        </div>
      </div>

      <div id="tour-overlay" style={tourOverlayStyle}>
        <div id="tour-label" style={{ fontSize: "1rem", marginBottom: "8px", color: "#c4b5fd" }}>
          Floor 1
        </div>
        <div style={{ display: "flex", gap: "10px", justifyContent: "center" }}>
          <button
            id="btn-tour-prev"
            style={{
              background: "rgba(255,255,255,0.1)",
              color: "#fff",
              border: "1px solid rgba(255,255,255,0.2)",
              padding: "6px 14px",
              borderRadius: "8px",
              cursor: "pointer",
            }}
          >
            ◀ Prev
          </button>
          <button
            id="btn-tour-next"
            style={{
              background: "rgba(124,58,237,0.6)",
              color: "#fff",
              border: "none",
              padding: "6px 14px",
              borderRadius: "8px",
              cursor: "pointer",
            }}
          >
            Next ▶
          </button>
          <button
            id="btn-tour-stop"
            style={{
              background: "rgba(220,38,38,0.6)",
              color: "#fff",
              border: "none",
              padding: "6px 14px",
              borderRadius: "8px",
              cursor: "pointer",
            }}
          >
            ✕ End Tour
          </button>
        </div>
      </div>
    </div>
  );
}
